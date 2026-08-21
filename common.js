/**
 * owner_split 数据层（中间方案）
 *
 * 用法：在页面原有 <script> 之后引入本文件，会覆盖 syncFromCloud / _doSaveToCloud / autoResolveConflict。
 * 需要 Supabase 已执行 supabase/owner_split/001_owner_data.sql 和 002_backfill_owner_data.sql。
 */
(function () {
  if (globalThis.__ownerSplitLoaded) return;
  globalThis.__ownerSplitLoaded = true;

  // ---------- 工具 ----------
  function getScopeOwners() {
    if (globalThis.TARGET_ORG) return [String(globalThis.TARGET_ORG).trim()];
    if (globalThis.DEFAULT_OWNER) return [String(globalThis.DEFAULT_OWNER).trim()];
    return null; // 管理员：看全部
  }

  function ownerOfRecord(record) {
    return String(record && (record.owner || record.owner_name || '')).trim() || '未分配';
  }

  function normalizeText(v) {
    return String(v == null ? '' : v).trim();
  }

  function taskOwner(task) {
    const direct = normalizeText(task && (task.sourceOwner || task.source_owner));
    if (direct) return direct;
    const username = normalizeText(task && task.username);
    if (!username) return '未分配';
    for (const listName of ['users', 'unused', 'trash']) {
      const rec = (globalThis.db?.[listName] || []).find(x => normalizeText(x.username).toLowerCase() === username.toLowerCase());
      if (rec && normalizeText(rec.owner)) return normalizeText(rec.owner);
    }
    return '未分配';
  }

  function normalizeOwnerContent(content) {
    const obj = content && typeof content === 'object' ? content : {};
    return {
      users: Array.isArray(obj.users) ? obj.users : [],
      unused: Array.isArray(obj.unused) ? obj.unused : [],
      trash: Array.isArray(obj.trash) ? obj.trash : [],
      bitTasks: Array.isArray(obj.bitTasks) ? obj.bitTasks : [],
      operationLogs: Array.isArray(obj.operationLogs) ? obj.operationLogs : []
    };
  }

  function normalizeGlobalContent(content) {
    const obj = content && typeof content === 'object' ? content : {};
    return {
      bitConnectors: Array.isArray(obj.bitConnectors) ? obj.bitConnectors : [],
      bitInventory: Array.isArray(obj.bitInventory) ? obj.bitInventory : [],
      bitUsernameRegistry: Array.isArray(obj.bitUsernameRegistry) ? obj.bitUsernameRegistry : []
    };
  }

  function emptyDb() {
    return {
      users: [], unused: [], trash: [],
      bitTasks: [], bitConnectors: [], bitInventory: [],
      bitUsernameRegistry: [], operationLogs: []
    };
  }

  function parseRowContent(row, normalizer) {
    let content = row && row.content;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch (e) { content = {}; }
    }
    return normalizer(content || {});
  }

  function computeVersion(ownerRows, globalRow) {
    const parts = (ownerRows || []).map(r => `${r.owner}:${r.updated_at}`).sort();
    parts.push(`global:${(globalRow && globalRow.updated_at) || ''}`);
    return parts.join('|');
  }

  function computeVersionFromRowVersions(rowVersions) {
    const parts = Object.keys(rowVersions || {}).filter(k => k !== '__global__').sort().map(k => `${k}:${rowVersions[k]}`);
    parts.push(`global:${(rowVersions && rowVersions.__global__) || ''}`);
    return parts.join('|');
  }

  async function fetchAllRows() {
    const owners = getScopeOwners();
    let ownerRows;
    if (owners) {
      const { data, error } = await supabaseClient.from('owner_data')
        .select('owner, content, updated_at')
        .in('owner', owners);
      if (error) throw error;
      ownerRows = data || [];
    } else {
      const { data, error } = await supabaseClient.from('owner_data')
        .select('owner, content, updated_at');
      if (error) throw error;
      ownerRows = data || [];
    }

    const { data: globalRow, error: globalError } = await supabaseClient.from('global_data')
      .select('id, content, updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (globalError) throw globalError;

    return { ownerRows, globalRow: globalRow || null };
  }

  function buildDbFromRows(ownerRows, globalRow) {
    const newDb = emptyDb();
    for (const row of ownerRows || []) {
      const c = parseRowContent(row, normalizeOwnerContent);
      newDb.users.push(...c.users);
      newDb.unused.push(...c.unused);
      newDb.trash.push(...c.trash);
      newDb.bitTasks.push(...c.bitTasks);
      newDb.operationLogs.push(...c.operationLogs);
    }
    const g = parseRowContent(globalRow || {}, normalizeGlobalContent);
    newDb.bitConnectors = g.bitConnectors;
    newDb.bitInventory = g.bitInventory;
    newDb.bitUsernameRegistry = g.bitUsernameRegistry;

    if (typeof normalizeDb === 'function') return normalizeDb(newDb);
    return newDb;
  }

  // ---------- 同步 ----------
  async function syncFromCloud(silent = false) {
    if (_isSyncing) {
      if (!silent && document.getElementById('syncStatus')) {
        document.getElementById('syncStatus').innerText = '☁️ 正在完成当前同步...';
      }
      return;
    }
    if (_isSaving || _hasPendingSave) {
      console.log('[sync] 正在保存或排队保存中，跳过此次同步');
      return;
    }
    if (silent && typeof hasActiveInlineEdit === 'function' && hasActiveInlineEdit()) return;

    _isSyncing = true;
    if (!silent && typeof showLoading === 'function') showLoading(true, { blocking: false });

    try {
      const { ownerRows, globalRow } = await fetchAllRows();
      const version = computeVersion(ownerRows, globalRow);

      if (lastKnownUpdatedAt && version === lastKnownUpdatedAt) {
        const timeStr = typeof getBeijingTimeString === 'function' ? getBeijingTimeString() : new Date().toLocaleTimeString('zh-CN', { hour12: false });
        if (document.getElementById('syncStatus')) document.getElementById('syncStatus').innerText = `✅ 已是最新 ${timeStr}`;
        return;
      }

      const newDb = buildDbFromRows(ownerRows, globalRow);
      db = newDb;
      if (typeof rebuildActiveConnectors === 'function') rebuildActiveConnectors();

      const rowVersions = {};
      for (const row of ownerRows || []) rowVersions[row.owner] = row.updated_at;
      rowVersions.__global__ = (globalRow && globalRow.updated_at) || '';
      globalThis.__rowVersions = rowVersions;

      if (typeof baseSnapshot !== 'undefined') baseSnapshot = JSON.parse(JSON.stringify(newDb));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newDb));
      lastKnownUpdatedAt = version;
      if (document.getElementById('syncStatus')) {
        document.getElementById('syncStatus').innerText = `✅ 云端同步 ${typeof getBeijingTimeString === 'function' ? getBeijingTimeString() : ''}`;
      }

      if (typeof render === 'function') render();
      if (typeof refreshBitIntegration === 'function') await refreshBitIntegration(true);
      if (typeof processExpiredUsers === 'function') await processExpiredUsers();
      if (typeof render === 'function') render();
    } catch (err) {
      console.error('[sync] 同步失败:', err);
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) {
        try {
          db = typeof normalizeDb === 'function' ? normalizeDb(JSON.parse(local)) : JSON.parse(local);
          if (typeof rebuildActiveConnectors === 'function') rebuildActiveConnectors();
          if (typeof render === 'function') render();
        } catch (e) {}
      }
      if (document.getElementById('syncStatus')) document.getElementById('syncStatus').innerText = '❌ 同步失败';
    } finally {
      _isSyncing = false;
      if (!silent && typeof showLoading === 'function') showLoading(false);
    }
  }

  // ---------- 保存 ----------
  function collectOwnersFromPayload(payload) {
    const owners = new Set();
    for (const listName of ['users', 'unused', 'trash']) {
      for (const rec of payload[listName] || []) owners.add(ownerOfRecord(rec));
    }
    for (const task of payload.bitTasks || []) owners.add(taskOwner(task));
    for (const log of payload.operationLogs || []) owners.add(ownerOfRecord(log));
    if (owners.size === 0) owners.add('未分配');
    return [...owners];
  }

  function buildOwnerPayloadFromSnapshot(payload, owner) {
    const result = { users: [], unused: [], trash: [], bitTasks: [], operationLogs: [] };
    for (const listName of ['users', 'unused', 'trash']) {
      for (const rec of payload[listName] || []) {
        if (ownerOfRecord(rec) === owner) result[listName].push(rec);
      }
    }
    for (const task of payload.bitTasks || []) {
      if (taskOwner(task) === owner) result.bitTasks.push(task);
    }
    for (const log of payload.operationLogs || []) {
      if (ownerOfRecord(log) === owner) result.operationLogs.push(log);
    }
    return result;
  }

  function buildGlobalPayloadFromSnapshot(payload) {
    return {
      bitConnectors: payload.bitConnectors || [],
      bitInventory: payload.bitInventory || [],
      bitUsernameRegistry: payload.bitUsernameRegistry || []
    };
  }

  async function upsertOwnerRow(owner, payload, expectedUpdatedAt) {
    const body = { content: payload, updated_at: new Date().toISOString() };
    if (expectedUpdatedAt) {
      const { data, error } = await supabaseClient.from('owner_data')
        .update(body)
        .eq('owner', owner)
        .eq('updated_at', expectedUpdatedAt)
        .select('updated_at');
      if (error) throw error;
      return { data, ok: !!(data && data.length > 0) };
    }
    const { data, error } = await supabaseClient.from('owner_data')
      .upsert({ owner: owner, content: payload, updated_at: new Date().toISOString() })
      .select('updated_at');
    if (error) throw error;
    return { data, ok: true };
  }

  async function upsertGlobalRow(payload, expectedUpdatedAt) {
    const now = new Date().toISOString();
    if (expectedUpdatedAt) {
      const { data, error } = await supabaseClient.from('global_data')
        .update({ content: payload, updated_at: now })
        .eq('id', 1)
        .eq('updated_at', expectedUpdatedAt)
        .select('updated_at');
      if (error) throw error;
      return { data, ok: !!(data && data.length > 0) };
    }
    const { data, error } = await supabaseClient.from('global_data')
      .upsert({ id: 1, content: payload, updated_at: now })
      .select('updated_at');
    if (error) throw error;
    return { data, ok: true };
  }

  async function _doSaveToCloud() {
    if (_isSaving) {
      scheduleCloudSave(120);
      return;
    }
    if (!_hasPendingSave) return;

    const revisionAtStart = _saveRevision;
    const isSilent = _isSilentSave;
    const payload = typeof snapshotMainData === 'function' ? snapshotMainData() : JSON.parse(JSON.stringify(db));
    _hasPendingSave = false;
    _isSilentSave = true;
    _isSaving = true;
    const statusEl = document.getElementById('syncStatus');
    if (statusEl) statusEl.innerText = '☁️ 正在上传...';

    if (!lastKnownUpdatedAt) {
      if (!isSilent) alert('⚠️ 云端尚未初始化，本次修改未上传。系统将自动重新同步。');
      _hasPendingSave = true;
      _isSaving = false;
      setTimeout(() => syncFromCloud(false), 0);
      return;
    }

    let conflictDetected = false;
    try {
      const rowVersions = globalThis.__rowVersions || {};
      const currentOwners = getScopeOwners() || collectOwnersFromPayload(payload);
      const knownOwners = Object.keys(rowVersions).filter(k => k !== '__global__');
      const owners = [...new Set([...currentOwners, ...knownOwners])];
      const nowIso = new Date().toISOString();
      const conflictRows = [];

      for (const owner of owners) {
        const ownerPayload = buildOwnerPayloadFromSnapshot(payload, owner);
        const expected = rowVersions[owner] || null;
        const res = await upsertOwnerRow(owner, ownerPayload, expected);
        if (!res.ok) conflictRows.push(owner);
        else rowVersions[owner] = (res.data && res.data[0] && res.data[0].updated_at) || nowIso;
      }

      const globalPayload = buildGlobalPayloadFromSnapshot(payload);
      const gExpected = rowVersions.__global__ || null;
      const gRes = await upsertGlobalRow(globalPayload, gExpected);
      if (!gRes.ok) conflictRows.push('__global__');
      else rowVersions.__global__ = (gRes.data && gRes.data[0] && gRes.data[0].updated_at) || nowIso;

      globalThis.__rowVersions = rowVersions;

      if (conflictRows.length) {
        conflictDetected = true;
        _hasPendingSave = true;
        if (!isSilent) _isSilentSave = false;
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--warning);font-weight:bold;">☁️ 冲突解决中，自动合并...</span>';
        const resolved = await autoResolveConflict();
        if (!resolved && !_saveRetryTimer) {
          _saveRetryTimer = setTimeout(() => {
            _saveRetryTimer = null;
            if (_hasPendingSave && !_isSaving) _doSaveToCloud();
          }, 3000);
        }
        return;
      }

      lastKnownUpdatedAt = computeVersionFromRowVersions(rowVersions);
      baseSnapshot = typeof snapshotMainData === 'function' ? snapshotMainData(payload) : JSON.parse(JSON.stringify(payload));

      if (_saveRevision !== revisionAtStart) {
        _hasPendingSave = true;
        if (statusEl) statusEl.innerText = '☁️ 前一批已保存，继续上传后续修改...';
      } else if (statusEl) {
        statusEl.innerText = `✅ 保存成功 ${typeof getBeijingTimeString === 'function' ? getBeijingTimeString() : ''}`;
      }
      if (_saveRetryTimer) { clearTimeout(_saveRetryTimer); _saveRetryTimer = null; }
    } catch (err) {
      console.error('[save] 上传失败:', err);
      _hasPendingSave = true;
      if (!isSilent) _isSilentSave = false;
      if (statusEl) statusEl.innerText = '⚠️ 网络失败，仅本地保存（待重试）';
      if (!_saveRetryTimer) {
        _saveRetryTimer = setTimeout(() => {
          _saveRetryTimer = null;
          if (_hasPendingSave && !_isSaving) _doSaveToCloud();
        }, 5000);
      }
    } finally {
      _isSaving = false;
      if (_hasPendingSave && !_saveRetryTimer && !conflictDetected) scheduleCloudSave(80);
    }
  }

  // ---------- 冲突合并（沿用原 MainData 的三向合并逻辑，改为读 owner_data/global_data） ----------
  async function autoResolveConflict(showMask = false) {
    if (showMask && typeof showLoading === 'function') showLoading(true);
    let latestData = null;
    let latestUpdatedAt = null;
    try {
      const { ownerRows, globalRow } = await fetchAllRows();
      latestData = buildDbFromRows(ownerRows, globalRow);
      latestUpdatedAt = computeVersion(ownerRows, globalRow);

      const rowVersions = {};
      for (const row of ownerRows || []) rowVersions[row.owner] = row.updated_at;
      rowVersions.__global__ = (globalRow && globalRow.updated_at) || '';
      globalThis.__rowVersions = rowVersions;
    } catch (err) {
      console.error('抓取最新数据合并失败', err);
      if (showMask && typeof showLoading === 'function') showLoading(false);
      if (typeof alert === 'function') alert('网络异常导致合并失败，请手动强制刷新！');
      return false;
    }

    if (!baseSnapshot || !latestData) {
      console.warn('无有效基线快照，保留本地待保存内容，不执行覆盖重载。');
      if (document.getElementById('syncStatus')) document.getElementById('syncStatus').innerText = '⚠️ 缺少合并基线，本地修改仍保留，等待重试';
      return false;
    }

    const localData = typeof snapshotMainData === 'function' ? snapshotMainData() : JSON.parse(JSON.stringify(db));

    function isEqualItem(a, b) {
      if (!a && !b) return true;
      if (!a || !b) return false;
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) if (a[k] !== b[k]) return false;
      return true;
    }

    let hasActivationClash = false;
    let hasUsernameClash = false;
    const fieldConflicts = [];
    const fieldLabels = { windows: '窗口数', password: '密码', wechat: '微信', expiry: '到期日期' };
    const discardedLocalTaskIds = new Set();
    const MISSING = Symbol('missing');

    const activeQuotaTask = (source, record) => {
      const task = (source.bitTasks || []).find(item => String(item.id) === String(record && record.windowJobId || ''));
      return task && String(task.action || '') === BIT_WINDOW_QUOTA_ACTION &&
        ['routing_required', 'pending', 'processing', 'retry_wait', 'needs_attention'].includes(String(task.status || ''))
        ? task : null;
    };

    const valueOf = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key) ? obj[key] : MISSING;
    const sameValue = (a, b) => {
      if (a === MISSING || b === MISSING) return a === b;
      return JSON.stringify(a) === JSON.stringify(b);
    };

    function mergeRecordFields(baseRecord, localRecord, remoteRecord) {
      const result = {};
      const keys = new Set([
        ...Object.keys(baseRecord || {}),
        ...Object.keys(localRecord || {}),
        ...Object.keys(remoteRecord || {})
      ]);
      for (const key of keys) {
        const baseValue = valueOf(baseRecord, key);
        const localValue = valueOf(localRecord, key);
        const remoteValue = valueOf(remoteRecord, key);
        const localChanged = !sameValue(localValue, baseValue);
        const remoteChanged = !sameValue(remoteValue, baseValue);
        let chosen;
        if (key === 'windowPaymentLock') {
          chosen = typeof mergeWindowPaymentLocks === 'function'
            ? mergeWindowPaymentLocks(localValue === MISSING ? undefined : localValue, remoteValue === MISSING ? undefined : remoteValue)
            : remoteValue;
          if (chosen !== undefined) result[key] = chosen;
          continue;
        }
        if (localChanged && remoteChanged && !sameValue(localValue, remoteValue)) {
          const localQuota = key === 'windows' ? activeQuotaTask(localData, localRecord) : null;
          const remoteQuota = key === 'windows' ? activeQuotaTask(latestData, remoteRecord) : null;
          chosen = localQuota && !remoteQuota ? localValue : remoteValue;
          if (localQuota && remoteQuota && String(localQuota.id) !== String(remoteQuota.id)) discardedLocalTaskIds.add(String(localQuota.id));
          if (fieldLabels[key] && !(key === 'windows' && localQuota && !remoteQuota)) {
            fieldConflicts.push({ username: (remoteRecord && remoteRecord.username) || (localRecord && localRecord.username) || '-', field: fieldLabels[key] });
          }
        } else if (localChanged) {
          chosen = localValue;
        } else {
          chosen = remoteValue;
        }
        if (chosen !== MISSING) result[key] = chosen;
      }
      return result;
    }

    function globallyMerge(baseObj, localObj, remoteObj) {
      function extractMap(dbObj) {
        const m = new Map();
        ['users', 'unused', 'trash'].forEach(listName => {
          for (const item of dbObj[listName] || []) m.set(item.id, { list: listName, data: item });
        });
        return m;
      }

      const baseMap = extractMap(baseObj);
      const localMap = extractMap(localObj);
      const remoteMap = extractMap(remoteObj);
      const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
      const finalIds = new Map();

      for (const id of allIds) {
        const baseInfo = baseMap.get(id);
        const localInfo = localMap.get(id);
        const remoteInfo = remoteMap.get(id);
        const isLocalSame = isEqualItem(localInfo && localInfo.data, baseInfo && baseInfo.data) && localInfo && localInfo.list === (baseInfo && baseInfo.list);
        const isRemoteSame = isEqualItem(remoteInfo && remoteInfo.data, baseInfo && baseInfo.data) && remoteInfo && remoteInfo.list === (baseInfo && baseInfo.list);

        if (isLocalSame) {
          if (remoteInfo) finalIds.set(id, remoteInfo);
        } else if (isRemoteSame) {
          if (localInfo) finalIds.set(id, localInfo);
        } else if (baseInfo && baseInfo.list === 'unused' && localInfo && localInfo.list === 'users' && remoteInfo && remoteInfo.list === 'users') {
          hasActivationClash = true;
          if (remoteInfo) finalIds.set(id, remoteInfo);
        } else if (localInfo && remoteInfo && localInfo.list === remoteInfo.list) {
          finalIds.set(id, {
            list: localInfo.list,
            data: mergeRecordFields((baseInfo && baseInfo.data) || {}, localInfo.data, remoteInfo.data)
          });
        } else if (localInfo) {
          finalIds.set(id, localInfo);
        }
      }

      const newDb = emptyDb();
      ['users', 'unused', 'trash'].forEach(listName => {
        const added = new Set();
        for (const item of localObj[listName] || []) {
          const finalInfo = finalIds.get(item.id);
          if (finalInfo && finalInfo.list === listName) {
            newDb[listName].push(finalInfo.data);
            added.add(item.id);
          }
        }
        for (const item of remoteObj[listName] || []) {
          const finalInfo = finalIds.get(item.id);
          if (finalInfo && finalInfo.list === listName && !added.has(item.id)) newDb[listName].push(finalInfo.data);
        }
      });

      const taskMap = new Map();
      for (const task of [...(remoteObj.bitTasks || []), ...(localObj.bitTasks || [])]) {
        if (!task || !task.id || discardedLocalTaskIds.has(String(task.id))) continue;
        const existing = taskMap.get(String(task.id));
        if (!existing || String(task.updatedAt || '') >= String(existing.updatedAt || '')) taskMap.set(String(task.id), task);
      }
      newDb.bitTasks = [...taskMap.values()];

      const baseOperationLogIds = new Set((baseObj.operationLogs || []).map(log => String(log && log.id)).filter(Boolean));
      const localOperationLogIds = new Set((localObj.operationLogs || []).map(log => String(log && log.id)).filter(Boolean));
      const remoteOperationLogIds = new Set((remoteObj.operationLogs || []).map(log => String(log && log.id)).filter(Boolean));
      const deletedOperationLogIds = new Set([
        ...[...baseOperationLogIds].filter(id => !localOperationLogIds.has(id)),
        ...[...baseOperationLogIds].filter(id => !remoteOperationLogIds.has(id))
      ]);
      const operationLogMap = new Map();
      for (const log of [...(remoteObj.operationLogs || []), ...(localObj.operationLogs || [])]) {
        if (!log || !log.id) continue;
        if (deletedOperationLogIds.has(String(log.id))) continue;
        const existing = operationLogMap.get(String(log.id));
        if (!existing || String(log.operatedAt || '') >= String(existing.operatedAt || '')) operationLogMap.set(String(log.id), log);
      }
      newDb.operationLogs = [...operationLogMap.values()];

      const connectorMap = new Map();
      for (const connector of [...(localObj.bitConnectors || []), ...(remoteObj.bitConnectors || [])]) {
        if (!connector || !connector.id) continue;
        if (typeof isExpiredConnectorRecord === 'function' && isExpiredConnectorRecord(connector)) continue;
        const existing = connectorMap.get(String(connector.id));
        if (!existing || String(connector.updatedAt || connector.lastSeen || '') >= String(existing.updatedAt || existing.lastSeen || '')) {
          connectorMap.set(String(connector.id), connector);
        }
      }
      newDb.bitConnectors = [...connectorMap.values()];

      const inventoryMap = new Map();
      for (const item of [...(localObj.bitInventory || []), ...(remoteObj.bitInventory || [])]) {
        const key = `${item && item.connectorId || ''}|${String((item && (item.usernameNorm || item.username)) || '').toLowerCase()}`;
        if (key === '|') continue;
        const existing = inventoryMap.get(key);
        if (!existing || String(item.lastSeen || '') >= String(existing.lastSeen || '')) inventoryMap.set(key, item);
      }
      newDb.bitInventory = [...inventoryMap.values()];

      const registryMap = new Map();
      for (const item of [...(remoteObj.bitUsernameRegistry || []), ...(localObj.bitUsernameRegistry || [])]) {
        const key = String((item && (item.usernameNorm || item.username)) || '').toLowerCase();
        if (!key) continue;
        const existing = registryMap.get(key);
        if (existing && String(existing.firstRecordId) !== String(item.firstRecordId)) {
          hasUsernameClash = true;
          continue;
        }
        if (!existing) registryMap.set(key, item);
      }
      newDb.bitUsernameRegistry = [...registryMap.values()];

      return newDb;
    }

    const mergedDb = globallyMerge(baseSnapshot, localData, latestData);

    if (hasActivationClash || hasUsernameClash) {
      if (typeof alert === 'function') {
        alert(hasUsernameClash
          ? '⚠️ 用户名永久唯一冲突！\n\n另一个页面刚刚抢先使用了相同用户名，本次本地操作已取消，系统已加载云端最新数据。'
          : '⚠️ 手慢无提示！\n\n您刚刚尝试激活的名额，已被其他同事抢先一步激活！\n为防止生成重复记录，您本次的激活操作已被拦截取消。\n\n系统已自动为您重新拉取最新的名额分配状态。');
      }
      if (typeof showLoading === 'function') showLoading(false);
      if (document.getElementById('syncStatus')) document.getElementById('syncStatus').innerHTML = `<span style="color:var(--danger);font-weight:bold;">❌ ${hasUsernameClash ? '用户名唯一冲突' : '激活手慢冲突'}</span>`;
      db.users = latestData.users;
      db.unused = latestData.unused;
      db.trash = latestData.trash;
      db.bitTasks = latestData.bitTasks || [];
      db.bitConnectors = latestData.bitConnectors || [];
      db.bitInventory = latestData.bitInventory || [];
      db.bitUsernameRegistry = latestData.bitUsernameRegistry || [];
      db.operationLogs = latestData.operationLogs || [];
      baseSnapshot = JSON.parse(JSON.stringify(db));
      lastKnownUpdatedAt = latestUpdatedAt;
      if (typeof render === 'function') render();
      _hasPendingSave = false;
      return true;
    }

    db.users = mergedDb.users;
    db.unused = mergedDb.unused;
    db.trash = mergedDb.trash;
    db.bitTasks = mergedDb.bitTasks || [];
    db.bitConnectors = mergedDb.bitConnectors || [];
    db.bitInventory = mergedDb.bitInventory || [];
    db.bitUsernameRegistry = mergedDb.bitUsernameRegistry || [];
    db.operationLogs = mergedDb.operationLogs || [];

    baseSnapshot = typeof snapshotMainData === 'function' ? snapshotMainData(latestData) : JSON.parse(JSON.stringify(latestData));
    lastKnownUpdatedAt = latestUpdatedAt;

    if (fieldConflicts.length && typeof alert === 'function') {
      const unique = [...new Set(fieldConflicts.map(item => `${item.username}：${item.field}`))];
      alert(`⚠️ 检测到其他用户同时修改同一资料：\n\n${unique.join('\n')}\n\n云端先保存的值已保留，本页面没有静默覆盖。其他不冲突的修改仍会继续保存。`);
    }

    saveToCloud(true);
    if (typeof render === 'function') render();
    if (typeof showLoading === 'function') showLoading(false);
    if (document.getElementById('syncStatus')) document.getElementById('syncStatus').innerHTML = '<span style="color:var(--warning);font-weight:bold;">☁️ 冲突已合并，正在重新上传全部修改...</span>';
    return true;
  }


  // 页面关闭前尽力把未保存内容写到 owner_data/global_data（keepalive，不阻塞关闭）
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', () => {
      if (!_hasPendingSave || !lastKnownUpdatedAt) return;
      try {
        const payload = typeof snapshotMainData === 'function' ? snapshotMainData() : JSON.parse(JSON.stringify(db));
        const owners = getScopeOwners() || collectOwnersFromPayload(payload);
        const now = new Date().toISOString();
        const baseUrl = `${SUPABASE_URL}/rest/v1`;
        const headers = {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        };
        for (const owner of owners) {
          const ownerPayload = buildOwnerPayloadFromSnapshot(payload, owner);
          const q = new URLSearchParams({ owner: `eq.${owner}` });
          fetch(`${baseUrl}/owner_data?${q.toString()}`, {
            method: 'PATCH', keepalive: true, headers,
            body: JSON.stringify({ content: ownerPayload, updated_at: now })
          });
        }
        const g = buildGlobalPayloadFromSnapshot(payload);
        fetch(`${baseUrl}/global_data?id=eq.1`, {
          method: 'PATCH', keepalive: true, headers,
          body: JSON.stringify({ content: g, updated_at: now })
        });
      } catch (e) {}
    });
  }

  // 覆盖原函数
  globalThis.syncFromCloud = syncFromCloud;
  globalThis._doSaveToCloud = _doSaveToCloud;
  globalThis.autoResolveConflict = autoResolveConflict;
})();
