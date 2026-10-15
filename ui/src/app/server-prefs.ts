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
  pendingUiPrefKeys,
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
  serializeStoredPrefs,
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

const preferenceWriteListeners = new Set<() => void>();
export function subscribeServerUiPrefWrites(listener: () => void): () => void {
  preferenceWriteListeners.add(listener);
  return () => preferenceWriteListeners.delete(listener);
}
function publishPreferenceWrites(): void {
  for (const listener of preferenceWriteListeners) {
    listener();
  }
}
class ServerUiPrefsOutbox implements ServerUiPrefsSync {
  applyingServerPrefs = false;
  pendingScope = "";
  pendingPrefs: ServerUiPrefs | null = null;
  pendingPersistedKeys = new Set<string>();
  composeSidebar: ServerUiPrefsSync["composeSidebar"] = null;
  pushWriter: ServerUiPrefsWriter | null = null;
  pushScope = "";
  pushClient: ServerUiPrefsSync["pushClient"] = null;
  pushProfileId: string | null = null;
  pushCanWrite = false;
  pushAfterCommit: ((commit: ServerUiPrefsCommit) => void) | undefined;
  pushDraining = false;
  drainRequested = false;
  pushEpoch = 0;
  confirmedPrefsFallback: ServerUiPrefsSync["confirmedPrefsFallback"] = null;
  lastReconciledScope: string | null = null;
  lastReconciledConfigObject: unknown = null;
  preferenceWriteFailures: ServerUiPrefsSync["preferenceWriteFailures"] = new Map();
  writePendingStorage = writePendingStorage;
  recordPreferenceWriteFailures = recordPreferenceWriteFailures;
  reconcilePersistedPendingPrefs = reconcilePersistedPendingPrefs;
  cancelPendingKeys = cancelPendingKeys;
  updateRetainedLocalKeys = updateRetainedLocalKeys;
  publishPreferenceWrites = publishPreferenceWrites;
  mergePendingIntoStorage = mergePendingIntoStorage;
  startPendingDrain = startPendingDrain;
  batchIsCurrent = batchIsCurrent;
  applyServerPrefsPatch = applyServerPrefsPatch;
}
// One owner survives lazy dispatch, resets, and connection changes.
export const serverUiPrefsOutbox = new ServerUiPrefsOutbox();
const sync = serverUiPrefsOutbox;
function recordPreferenceWriteFailures(
  scope: string,
  values: ServerUiPrefs,
  error: unknown,
  retained = false,
): void {
  const failures = sync.preferenceWriteFailures.get(scope) ?? new Map();
  for (const key of SYNCED_PREF_KEYS) {
    if (!Object.hasOwn(values, key)) {
      continue;
    }
    failures.set(key, {
      value: values[key],
      error: error instanceof Error ? error.message : String(error),
      retained,
    });
  }
  sync.preferenceWriteFailures.set(scope, failures);
}
function updateRetainedLocalKeys(
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
    stored.available && stored.prefs ? pendingUiPrefKeys(stored.prefs) : [],
  );
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  if (prefs && !prefs.sidebarEntries) {
    clearSidebarEntriesMetadata(prefs);
  }
  const persisted = writeStorage(
    PENDING_KEY,
    sync.pendingScope,
    prefs && Object.keys(prefs).length ? serializeStoredPrefs(prefs) : null,
  );
  if (persisted) {
    sync.pendingPersistedKeys = new Set(
      sync.pendingPrefs ? pendingUiPrefKeys(sync.pendingPrefs) : [],
    );
  } else {
    sync.pendingPersistedKeys.clear();
  }
}
function cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void {
  for (const key of keys) {
    sync.preferenceWriteFailures.get(scope)?.delete(key);
  }
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
  writeStorage(PENDING_KEY, scope, next ? serializeStoredPrefs(next) : null);
}
// localStorage pending is a cross-tab merged pool per gateway. Per-key read-merge-write prevents
// one tab from clobbering sibling offline intent; its ms-scale race is accepted because storage has
// no CAS and the drain converges through server-side LWW.
function mergePendingIntoStorage(ackedBatch: ServerUiPrefs = {}): void {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, sync.pendingScope)) ?? {};
  for (const key of pendingUiPrefKeys(ackedBatch)) {
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
  for (const key of new Set([...SYNCED_PREF_KEYS, ...sync.pendingPersistedKeys])) {
    if (
      !sync.pendingPersistedKeys.has(key) &&
      (Object.hasOwn(pending, key) || !adoptKeys.some((candidate) => candidate === key))
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
    pendingUiPrefKeys(batch).every(
      (key) =>
        !Object.hasOwn(batch, key) ||
        (Object.hasOwn(current, key) && prefIntentMatches(current, batch, key)),
    ),
  );
}
export function resetServerUiPrefsSync() {
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
  sync.preferenceWriteFailures.clear();
  sync.pushEpoch += 1;
  publishPreferenceWrites();
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
function startPendingDrain(writer: ServerUiPrefsWriter): void {
  // Offline intent must not load dispatch or invalidate another profile.
  if (!writer.state.connected) {
    return;
  }
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
  void import("./server-prefs-drain.ts")
    .then(({ drainPendingPrefs }) => drainPendingPrefs(sync, writer, epoch))
    .catch((error: unknown) => {
      if (sync.pushWriter !== writer || sync.pushEpoch !== epoch || !sync.pendingPrefs) {
        return;
      }
      recordPreferenceWriteFailures(sync.pendingScope, sync.pendingPrefs, error);
      publishPreferenceWrites();
    })
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
  sync.pushAfterCommit = hooks.afterCommit;
  const keys = SYNCED_PREF_KEYS.filter((key) => Object.hasOwn(prefs, key));
  for (const key of keys) {
    sync.preferenceWriteFailures.get(sync.pendingScope)?.delete(key);
  }
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
    publishPreferenceWrites();
    hooks.afterCommit?.({ needsRefresh: false, retainedLocal: true });
    if (blockedKeys.length === keys.length) {
      return;
    }
  }
  updateRetainedLocalKeys(
    sync.pendingScope,
    keys.filter((key) => !blockedKeys.includes(key)),
    false,
  );
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
  publishPreferenceWrites();
  startPendingDrain(writer);
}
export function flushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  hooks: ServerUiPrefsPushHooks = {},
): void {
  adoptPushWriter(writer, hooks);
  reconcilePersistedPendingPrefs(SYNCED_PREF_KEYS);
  sync.pushEpoch += 1;
  sync.pushDraining = sync.drainRequested = false;
  sync.composeSidebar = null;
  sync.pushAfterCommit = hooks.afterCommit;
  startPendingDrain(writer);
}

function applyServerPrefsPatch(patch: Partial<UiSettings>): void {
  sync.applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    sync.applyingServerPrefs = false;
  }
}
