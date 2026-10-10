// Server-side operator display prefs (config ui.prefs) are canonical: agents change them through
// the approval gate and other devices pick them up. The localStorage mirror gives instant boot and
// stays authoritative when this client cannot write config (viewer scope, offline). Pending local
// intent shadows server snapshots until the hash-free LWW ack; failed pushes degrade device-local.
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import {
  mergePendingUiPrefs,
  resetServerUiPrefIntent,
  prefIntentMatches,
} from "./server-prefs-intent.ts";
import {
  rememberProfileAppearanceIdentity,
  resetProfileAppearancePrefs,
  resolveProfileAppearanceProfileId,
  resolveProfilePreferenceScope,
} from "./server-prefs-profile.ts";
import {
  isNavigationPref,
  clearSidebarEntriesMetadata,
  isProfilePref,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ServerUiPrefs,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import {
  PENDING_KEY,
  parseStoredPrefs,
  readRetainedLocalKeys,
  readStorage,
  readStoredPrefs,
  writeRetainedLocalKeys,
  writeStorage,
} from "./server-prefs-storage.ts";
import type {
  ServerUiPrefsWriter,
  ServerUiPrefsCommit,
  ServerUiPrefsSync,
} from "./server-prefs-sync-contract.ts";
import type { UiSettings } from "./settings-contract.ts";
import { patchSettings } from "./settings.ts";

type ServerUiPrefsPushHooks = {
  afterCommit?: (commit: ServerUiPrefsCommit) => void;
  profileId?: string | null;
  canWrite?: boolean;
  profile?: Pick<ApplicationGatewaySnapshot, "selfUser" | "hello"> | null;
};
export type { ServerUiPrefProvenance } from "./server-prefs-state.ts";

const CONFLICT_REDRAIN_DELAY_MS = 1_000;
const MAX_CONFLICT_REDRAINS = 5;
export const serverUiPrefsSync: ServerUiPrefsSync = {
  applyingServerPrefs: false,
  pendingScope: "",
  pendingPrefs: null,
  pendingPersistedKeys: new Set(),
  composeSidebar: null,
  pushWriter: null,
  pushScope: "",
  pushClient: null,
  pushProfileId: null,
  pushCanWrite: false,
  pushAfterCommit: undefined,
  pushDraining: false,
  drainRequested: false,
  pushEpoch: 0,
  conflictRedrainTimer: null,
  consecutiveConflictRedrains: 0,
  confirmedPrefsFallback: null,
  lastReconciledScope: null,
  lastReconciledConfigObject: null,
};
const sync = serverUiPrefsSync;
function clearConflictRedrain(): void {
  if (sync.conflictRedrainTimer !== null) {
    clearTimeout(sync.conflictRedrainTimer);
    sync.conflictRedrainTimer = null;
  }
  sync.consecutiveConflictRedrains = 0;
}
export function updateRetainedLocalKeys(
  scope: string,
  keys: readonly SyncedPrefKey[],
  retained: boolean,
): void {
  const stored = readRetainedLocalKeys(scope);
  for (const key of keys) {
    if (retained) {
      stored.add(key);
    } else {
      stored.delete(key);
    }
  }
  writeRetainedLocalKeys(scope, stored);
  if (retained && scope === sync.lastReconciledScope) {
    sync.lastReconciledConfigObject = null;
  }
}
function adoptPendingScope(scope: string): void {
  sync.composeSidebar = null;
  sync.pendingScope = scope;
  const stored = readStoredPrefs(PENDING_KEY, scope);
  sync.pendingPrefs = stored.prefs;
  sync.pendingPersistedKeys = new Set(
    SYNCED_PREF_KEYS.filter((key) => stored.prefs && Object.hasOwn(stored.prefs, key)),
  );
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  if (prefs && !prefs.sidebarEntries) {
    clearSidebarEntriesMetadata(prefs);
  }
  const persisted = writeStorage(
    PENDING_KEY,
    sync.pendingScope,
    prefs && Object.keys(prefs).length ? JSON.stringify(prefs) : null,
  );
  if (persisted) {
    sync.pendingPersistedKeys = new Set(
      SYNCED_PREF_KEYS.filter((key) => sync.pendingPrefs && Object.hasOwn(sync.pendingPrefs, key)),
    );
  } else {
    sync.pendingPersistedKeys.clear();
  }
}
export function cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void {
  if (scope === sync.pendingScope) {
    reconcilePersistedPendingPrefs();
  }
  const active = scope === sync.pendingScope ? sync.pendingPrefs : null;
  const remaining = {
    ...parseStoredPrefs(readStorage(PENDING_KEY, scope)),
    ...active,
  };
  for (const key of keys) {
    delete remaining[key];
  }
  if (!remaining.sidebarEntries) {
    clearSidebarEntriesMetadata(remaining);
  }
  const next = Object.keys(remaining).length ? remaining : null;
  if (scope === sync.pendingScope) {
    sync.pendingPrefs = next;
    if (keys.includes("sidebarEntries")) {
      sync.composeSidebar = null;
    }
    writePendingStorage(next);
    return;
  }
  writeStorage(PENDING_KEY, scope, next ? JSON.stringify(next) : null);
}
// localStorage pending is a cross-tab merged pool per gateway. Per-key read-merge-write prevents
// one tab from clobbering sibling offline intent; its ms-scale race is accepted because storage has
// no CAS and the drain converges through server-side LWW.
function mergePendingIntoStorage(ackedBatch: ServerUiPrefs = {}): void {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, sync.pendingScope)) ?? {};
  for (const key of SYNCED_PREF_KEYS) {
    if (Object.hasOwn(ackedBatch, key) && prefIntentMatches(stored, ackedBatch, key)) {
      delete stored[key];
      if (key === "sidebarEntries") {
        clearSidebarEntriesMetadata(stored);
      }
    }
  }
  const merged = { ...stored, ...sync.pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
// Edits/replay may adopt sibling keys; passive ACK validation only reconciles owned keys.
// A held in-memory-only key could not be persisted, so storage cannot supersede it.
function reconcilePersistedPendingPrefs(adoptKeys: readonly SyncedPrefKey[] = []): void {
  const stored = readStoredPrefs(PENDING_KEY, sync.pendingScope);
  if (!stored.available) {
    return;
  }
  const current = stored.prefs ?? {};
  const pending = sync.pendingPrefs ?? {};
  for (const key of SYNCED_PREF_KEYS) {
    if (
      !sync.pendingPersistedKeys.has(key) &&
      (Object.hasOwn(pending, key) || !adoptKeys.includes(key))
    ) {
      continue;
    }
    if (key === "sidebarEntries" && !prefIntentMatches(pending, current, key)) {
      sync.composeSidebar = null;
    }
    if (!Object.hasOwn(current, key)) {
      delete pending[key];
      sync.pendingPersistedKeys.delete(key);
      continue;
    }
    Object.assign(pending, { [key]: current[key] });
    sync.pendingPersistedKeys.add(key);
    if (key === "sidebarEntries") {
      pending.sidebarEntriesBase = current.sidebarEntriesBase;
      pending.sidebarEntriesOrder = current.sidebarEntriesOrder;
    }
  }
  if (!pending.sidebarEntries) {
    clearSidebarEntriesMetadata(pending);
  }
  sync.pendingPrefs = Object.keys(pending).length ? pending : null;
}
function batchIsCurrent(batch: ServerUiPrefs): boolean {
  const current = sync.pendingPrefs;
  return Boolean(
    current &&
    SYNCED_PREF_KEYS.every(
      (key) =>
        !Object.hasOwn(batch, key) ||
        (Object.hasOwn(current, key) && prefIntentMatches(current, batch, key)),
    ),
  );
}
export function resetServerUiPrefsSync() {
  clearConflictRedrain();
  sync.applyingServerPrefs = sync.pushDraining = sync.drainRequested = false;
  sync.pendingScope = "";
  sync.pendingPrefs = sync.pushWriter = null;
  sync.composeSidebar = null;
  sync.pendingPersistedKeys.clear();
  sync.pushScope = "";
  sync.pushClient = null;
  sync.pushProfileId = null;
  sync.pushCanWrite = false;
  sync.confirmedPrefsFallback = null;
  sync.lastReconciledScope = null;
  sync.lastReconciledConfigObject = null;
  resetProfileAppearancePrefs();
  resetServerUiPrefIntent();
}

export function isApplyingServerUiPrefs(): boolean {
  return sync.applyingServerPrefs;
}
function adoptPushWriter(writer: ServerUiPrefsWriter, hooks: ServerUiPrefsPushHooks): void {
  const gatewayScope = writer.state.client?.gatewayUrl ?? "";
  // Disconnect clears selfUser; remembered identity scopes only the offline outbox, not authority.
  const profileId =
    hooks.profileId ??
    hooks.profile?.selfUser?.id ??
    (writer.state.connected ? null : resolveProfileAppearanceProfileId(gatewayScope));
  if (profileId) {
    rememberProfileAppearanceIdentity(gatewayScope, profileId);
  } else if (writer.state.connected) {
    resetProfileAppearancePrefs();
  }
  const scope = resolveProfilePreferenceScope(gatewayScope, profileId);
  sync.pushCanWrite = hooks.canWrite ?? hasOperatorWriteAccess(hooks.profile?.hello?.auth ?? null);
  if (
    sync.pushWriter === writer &&
    sync.pushScope === scope &&
    sync.pushProfileId === profileId &&
    sync.pushClient === writer.state.client
  ) {
    return;
  }
  // Reconcile the scope being left before moving pre-connection intent forward.
  // Otherwise another tab can cancel storage while this realm later resurrects its stale memory.
  reconcilePersistedPendingPrefs();
  const unscopedPending =
    sync.pendingScope === ""
      ? {
          ...parseStoredPrefs(readStorage(PENDING_KEY, "")),
          ...sync.pendingPrefs,
        }
      : null;
  clearConflictRedrain();
  sync.pushEpoch += 1;
  sync.pushWriter = writer;
  sync.pushClient = writer.state.client;
  sync.pushScope = scope;
  sync.pushProfileId = profileId;
  sync.pushDraining = false;
  adoptPendingScope(scope);
  if (scope && unscopedPending && Object.keys(unscopedPending).length) {
    // A preference can be edited before the first gateway client is adopted.
    // Move only that unscoped intent forward; preferences from one real
    // gateway must never bleed into another gateway's scope.
    const transferable = Object.fromEntries(
      Object.entries(unscopedPending).filter(
        ([key]) =>
          !isNavigationPref(key) && key !== "sidebarEntriesBase" && key !== "sidebarEntriesOrder",
      ),
    );
    const merged = { ...sync.pendingPrefs, ...transferable };
    sync.pendingPrefs = Object.keys(merged).length ? merged : null;
    mergePendingIntoStorage();
    writeStorage(PENDING_KEY, "", null);
  }
}
// Conflicts mean another writer committed, so bounded rescheduling converges under progress.
// The cap prevents an endlessly conflicting server from keeping a timer chain alive.
function scheduleConflictRedrain(writer: ServerUiPrefsWriter, epoch: number): void {
  if (
    sync.conflictRedrainTimer !== null ||
    sync.consecutiveConflictRedrains >= MAX_CONFLICT_REDRAINS
  ) {
    return;
  }
  sync.consecutiveConflictRedrains += 1;
  sync.conflictRedrainTimer = setTimeout(() => {
    sync.conflictRedrainTimer = null;
    if (sync.pushWriter === writer && sync.pushEpoch === epoch && sync.pendingPrefs) {
      startPendingDrain(writer);
    }
  }, CONFLICT_REDRAIN_DELAY_MS);
}

async function drainPendingPrefs(writer: ServerUiPrefsWriter, epoch: number): Promise<void> {
  const runtime = await import("./server-prefs-drain.ts");
  return runtime.drainPendingPrefs(writer, epoch, sync, {
    scheduleConflictRedrain,
    reconcilePersistedPendingPrefs,
    cancelPendingKeys,
    updateRetainedLocalKeys,
    batchIsCurrent,
    applyServerPrefsPatch,
    mergePendingIntoStorage,
    clearConflictRedrain,
  });
}
function startPendingDrain(writer: ServerUiPrefsWriter): void {
  if (sync.pushDraining) {
    sync.drainRequested = true;
    return;
  }
  if (!sync.pendingPrefs) {
    return;
  }
  if (
    writer.state.connected &&
    writer.canPatch === false &&
    !(sync.pushProfileId && sync.pushCanWrite && Object.keys(sync.pendingPrefs).some(isProfilePref))
  ) {
    return;
  }
  sync.pushDraining = true;
  const epoch = sync.pushEpoch;
  void drainPendingPrefs(writer, epoch)
    .catch(() => undefined)
    .finally(() => {
      if (sync.pushWriter === writer && sync.pushEpoch === epoch) {
        sync.pushDraining = false;
        if (sync.drainRequested) {
          sync.drainRequested = false;
          startPendingDrain(writer);
        }
      }
    });
}
export function pushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  prefs: ServerUiPrefs,
  hooks: ServerUiPrefsPushHooks = {},
): void {
  adoptPushWriter(writer, hooks);
  clearConflictRedrain();
  sync.pushAfterCommit = hooks.afterCommit;
  const keys = SYNCED_PREF_KEYS.filter((key) => Object.hasOwn(prefs, key));
  const blockedKeys = writer.state.connected
    ? keys.filter((key) => {
        if (SYNCED_PREFS[key].configSync === false && !sync.pushProfileId) {
          return true;
        }
        if (sync.pushProfileId && isProfilePref(key)) {
          // Imported custom palettes are browser-local by contract; a profile
          // must never carry a theme another browser cannot render.
          return !sync.pushCanWrite || (key === "theme" && prefs.theme === "custom");
        }
        return writer.canPatch === false;
      })
    : [];
  if (blockedKeys.length) {
    // A connected read-only edit is intentionally browser-local. Supersede only
    // same-key offline intent so a later authorization cannot replay stale input.
    cancelPendingKeys(sync.pendingScope, blockedKeys);
    updateRetainedLocalKeys(sync.pendingScope, blockedKeys, true);
    hooks.afterCommit?.({ needsRefresh: false, retainedLocal: true });
    if (blockedKeys.length === keys.length) {
      return;
    }
  }
  const writablePrefs = blockedKeys.length
    ? Object.fromEntries(
        Object.entries(prefs).filter(
          ([key]) => !blockedKeys.some((blockedKey) => blockedKey === key),
        ),
      )
    : prefs;
  reconcilePersistedPendingPrefs(keys);
  sync.composeSidebar?.(sync.pendingPrefs, writablePrefs);
  sync.pendingPrefs = mergePendingUiPrefs(sync.pendingPrefs, writablePrefs);
  mergePendingIntoStorage();
  startPendingDrain(writer);
}
export function flushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  hooks: ServerUiPrefsPushHooks = {},
): void {
  adoptPushWriter(writer, hooks);
  reconcilePersistedPendingPrefs(SYNCED_PREF_KEYS);
  clearConflictRedrain();
  sync.pushEpoch += 1;
  sync.pushDraining = sync.drainRequested = false;
  sync.composeSidebar = null;
  sync.pushAfterCommit = hooks.afterCommit;
  startPendingDrain(writer);
}

export function applyServerPrefsPatch(patch: Partial<UiSettings>): void {
  sync.applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    sync.applyingServerPrefs = false;
  }
}
