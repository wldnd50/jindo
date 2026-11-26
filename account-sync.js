'use strict';

const firebaseConfig = {
  apiKey: 'AIzaSyCn574WvQqpzatufm4GJvZ2OHL2JJMGWFE',
  authDomain: 'jindo-ab11e.firebaseapp.com',
  projectId: 'jindo-ab11e',
  appId: '1:809517969175:web:a56b5d9296576242b59152'
};

let sdk, auth, db, account;
let initializing;
const byId = id => document.getElementById(id);

function syncPayload(data) {
  const {version, classes, periodsPerDay, periodTimes, baseTimetable, weeks, progress, lastBackup} = data;
  return JSON.stringify({version, classes, periodsPerDay, periodTimes, baseTimetable, weeks, progress, lastBackup});
}

function syncStatus(message, kind = '') {
  byId('cloud-status').textContent = message;
  byId('cloud-status').className = 'cloud-status ' + kind;
  byId('account-indicator').textContent = account ? message : 'Google 계정 연결';
  byId('sync-retry').hidden = !account || kind !== 'err' || !!account.conflict;
}

function syncButtons() {
  byId('google-login').hidden = !!account;
  byId('google-logout').hidden = !account;
  byId('device-import').hidden = !account || !hasGuestData();
  byId('legacy-import').hidden = !account || !previousSyncCode();
  byId('account-conflict').hidden = !account?.conflict;
  byId('account-email').textContent = account?.user.email || '';
}

function guestData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : buildSeedState();
}

function hasGuestData() {
  return syncPayload(guestData()) !== syncPayload(buildSeedState());
}

function previousSyncCode() {
  try {
    const old = JSON.parse(localStorage.getItem('jindoApp_cloud_v1'));
    return old?.config?.projectId === firebaseConfig.projectId && old.code;
  } catch { return null; }
}

async function importPreviousSync() {
  const s = account;
  const code = previousSyncCode();
  if (!s?.ready || s.conflict || !code) return showToast('계정 연결 상태를 먼저 확인해 주세요.');
  try {
    const snap = await sdk.getDocFromServer(sdk.doc(db, 'jindoSync', code));
    if (account !== s) return;
    if (!snap.exists()) return showToast('이전 동기화 기록이 없습니다.');
    const old = snap.data();
    const data = old.payload ? JSON.parse(old.payload) : old;
    if (!Array.isArray(data.classes) || !Array.isArray(data.baseTimetable)) throw new Error();
    if (!confirm('예전 동기화 코드에 저장된 시간표와 진도로 현재 계정 기록을 교체할까요?')) return;
    setAccountData(syncPayload(data));
    queueAccountSave();
  } catch {
    if (account === s) showToast('이전 기록을 불러오지 못했습니다. 이 기기 기록도 가져올 수 있습니다.');
  }
}

function saveAccountCopy() {
  localStorage.setItem(account.key, JSON.stringify({state, base: account.base, revision: account.revision}));
}

function setAccountData(payload) {
  const ui = state.ui;
  state = {...JSON.parse(payload), ui};
  migrateIfNeeded();
  if (!state.classes.some(c => c.id === ui.activeClass)) ui.activeClass = state.classes[0]?.id || null;
  saveAccountCopy();
  render();
}

function importDeviceData() {
  if (!account || !account.ready || account.conflict) {
    showToast('계정 기록을 확인한 뒤 다시 시도해 주세요.');
    return;
  }
  if (!confirm('이 기기의 로그인 전 시간표와 진도로 현재 계정 기록을 교체할까요?')) return;
  setAccountData(syncPayload(guestData()));
  queueAccountSave();
}

function readRecord(snap) {
  if (!snap.exists()) return {revision: 0, payload: syncPayload(buildSeedState())};
  const record = snap.data();
  const data = JSON.parse(record.payload);
  if (!Number.isSafeInteger(record.revision) || !Array.isArray(data.classes) || !Array.isArray(data.baseTimetable)) {
    throw new Error('계정 기록의 형식을 확인해 주세요.');
  }
  return record;
}

function acceptRemote(s, record) {
  s.revision = record.revision;
  s.base = record.payload;
  s.conflict = null;
  if (syncPayload(state) === record.payload) saveAccountCopy();
  else setAccountData(record.payload);
  syncButtons();
  syncStatus('동기화 완료', 'ok');
}

function reconcile(s) {
  if (s !== account || s.busy || !s.latest || state.ui.modal) return;
  const remote = s.latest;
  s.latest = null;
  if (remote.revision < s.revision) return;
  const local = syncPayload(state);
  if (local === s.base || local === remote.payload) {
    acceptRemote(s, remote);
  } else if (remote.revision === s.revision && remote.payload === s.base) {
    queueAccountSave();
  } else {
    s.conflict = remote;
    syncButtons();
    syncStatus('두 기기의 수정이 겹쳤습니다. 설정에서 사용할 기록을 선택해 주세요.', 'err');
  }
}

function resolveAccountConflict(useLocal) {
  const s = account;
  if (!s?.conflict || !confirm(useLocal ? '현재 기기의 기록으로 계정 기록을 교체할까요?' : '계정 기록을 불러와 이 기기의 변경을 교체할까요?')) return;
  const remote = s.conflict;
  if (!useLocal) return acceptRemote(s, remote);
  s.base = remote.payload;
  s.revision = remote.revision;
  s.conflict = null;
  saveAccountCopy();
  syncButtons();
  queueAccountSave();
}

function queueAccountSave(delay = 250) {
  const s = account;
  if (!s?.ready || s.busy || s.conflict || syncPayload(state) === s.base) return;
  clearTimeout(s.timer);
  if (delay < 10000) syncStatus('이 기기에 저장됨 · 동기화 대기');
  s.timer = setTimeout(() => upload(s), delay);
}

async function upload(s) {
  if (account !== s || s.busy || s.conflict || !s.ready) return;
  const payload = syncPayload(state);
  if (payload === s.base) return;
  const revision = s.revision;
  s.busy = true;
  let retryDelay = 250;
  try {
    const result = await sdk.runTransaction(db, async tx => {
      const remote = readRecord(await tx.get(s.ref));
      if (account !== s || auth.currentUser?.uid !== s.user.uid) throw new Error('계정이 변경되었습니다.');
      if (remote.revision !== revision) return {remote};
      tx.set(s.ref, {payload, revision: revision + 1});
      return {saved: true};
    });
    if (account !== s) return;
    if (result.saved) {
      s.base = payload;
      s.revision = revision + 1;
      saveAccountCopy();
      syncStatus('동기화 완료', 'ok');
    } else if (!s.latest || s.latest.revision <= result.remote.revision) {
      s.latest = result.remote;
    }
  } catch (error) {
    if (account !== s) return;
    retryDelay = 10000;
    syncStatus('이 기기에 저장됨 · 동기화 재시도 대기', 'err');
    console.warn('진도 동기화', error.code || error.message);
  } finally {
    s.busy = false;
    if (account === s) {
      reconcile(s);
      if (!s.latest) queueAccountSave(retryDelay);
    }
  }
}

function observeAccount(s) {
  s.unsubscribe?.();
  s.unsubscribe = sdk.onSnapshot(s.ref, {includeMetadataChanges: true}, snap => {
    if (account !== s || snap.metadata.hasPendingWrites) return;
    if (snap.metadata.fromCache) {
      syncStatus('이 기기에 저장됨 · 서버 연결 대기');
      return;
    }
    try {
      const first = !s.ready;
      s.latest = readRecord(snap);
      s.ready = true;
      reconcile(s);
      if (first && !snap.exists() && s.newDevice && hasGuestData() && syncPayload(state) === s.base) {
        importDeviceData();
      }
    } catch (error) {
      s.ready = false;
      syncStatus('계정 기록을 읽을 수 없습니다. 설정에서 다시 연결해 주세요.', 'err');
    }
  }, error => {
    if (account !== s) return;
    s.ready = false;
    syncStatus('계정 연결 실패 · 다시 연결해 주세요. (' + error.code + ')', 'err');
  });
}

function switchAccount(user) {
  if (account && account.user.uid === user?.uid) return;
  account?.unsubscribe?.();
  clearTimeout(account?.timer);
  const tab = state.ui.activeTab;
  const wasAccount = !!account;
  account = null;
  if (!user) {
    if (wasAccount) {
      loadState();
      state.ui.modal = null;
      state.ui.activeTab = tab;
      render();
    }
    syncButtons();
    syncStatus('로그인하면 계정에 자동 저장됩니다.');
    return;
  }
  const key = STORAGE_KEY + ':google:' + user.uid;
  const cached = JSON.parse(localStorage.getItem(key) || 'null');
  state = cached?.state || buildSeedState();
  migrateIfNeeded();
  state.ui.modal = null;
  state.ui.activeTab = tab;
  account = {user, key, ref: sdk.doc(db, 'jindoAccounts', user.uid), newDevice: !cached,
    revision: cached?.revision || 0, base: cached?.base || syncPayload(buildSeedState()), ready: false};
  syncButtons();
  render();
  syncStatus('계정 기록 확인 중…');
  observeAccount(account);
}

function initAccountSync() {
  if (initializing) return initializing;
  initializing = (async () => {
    const modules = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
    ]);
    sdk = Object.assign({}, ...modules);
    const app = sdk.initializeApp(firebaseConfig);
    auth = sdk.getAuth(app);
    db = sdk.getFirestore(app);
    sdk.onAuthStateChanged(auth, switchAccount);
  })().catch(error => {
    initializing = null;
    syncStatus('Google 연결을 준비하지 못했습니다. 인터넷 연결 후 다시 시도해 주세요.', 'err');
    throw error;
  });
  return initializing;
}

async function googleLogin() {
  try {
    if (!auth) await initAccountSync();
    const provider = new sdk.GoogleAuthProvider();
    provider.setCustomParameters({prompt: 'select_account'});
    await sdk.signInWithPopup(auth, provider);
  } catch (error) {
    syncStatus(error.code === 'auth/popup-closed-by-user' ? '로그인이 취소되었습니다.'
      : 'Google 로그인 실패 · 팝업과 인터넷 연결을 확인해 주세요. (' + (error.code || '연결 오류') + ')', 'err');
  }
}

async function googleLogout() {
  if (!account) return;
  if (syncPayload(state) !== account.base && !confirm('아직 동기화 중인 기록이 있습니다. 이 기기에 보관하고 로그아웃할까요? 같은 계정으로 돌아오면 다시 동기화합니다.')) return;
  try { await sdk.signOut(auth); } catch { syncStatus('로그아웃에 실패했습니다. 다시 시도해 주세요.', 'err'); }
}
