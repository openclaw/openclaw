// Server-side operator display prefs (config ui.prefs) are canonical: agents change them through
// the approval gate and other devices pick them up. The localStorage mirror gives instant boot and
// stays authoritative when this client cannot write config (viewer scope, offline). Pending local
// intent shadows server snapshots until the hash-free LWW ack; failed pushes degrade device-local.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import { resetServerUiPrefIntent } from "./server-prefs-intent.ts";
import {
  loadProfileAppearancePrefs,
  rememberProfileAppearanceIdentity,
  resetProfileAppearancePrefs,
  resolveProfileAppearanceProfileId,
  resolveProfileAppearancePrefs,
  resolveProfilePreferenceScope,
} from "./server-prefs-profile.ts";
import {
  extractServerUiPrefs,
  isAppearancePref,
  prefValuesEqual,
  resolveServerUiPrefStateFromSnapshot,
  serverPrefsLocalPatch,
  serverUiPrefsSnapshotDelta,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ServerUiPrefs,
  type ServerUiPrefState,
  type SyncedPrefKey,
  type SyncedPrefValue,
} from "./server-prefs-state.ts";
import {
  LAST_SEEN_KEY,
  PENDING_KEY,
  parseStoredPrefs,
  readRetainedLocalKeys,
  readStorage,
  readStoredPrefs,
  writeRetainedLocalKeys,
  writeStorage,
} from "./server-prefs-storage.ts";
import { loadSettings, patchSettings, type UiSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";

export type ServerUiPrefsWriter = Pick<
  RuntimeConfigCapability,
  "canPatch" | "runExternalMutation"
> & {
  readonly state: {
    readonly client: GatewayBrowserClient | null;
    readonly connected: boolean;
    readonly configSnapshot?: { readonly config?: unknown } | null;
  };
};
type ServerUiPrefsCommit = {
  needsRefresh: boolean;
  retainedLocal?: boolean;
};
type PreferenceWriteFailure = { value: unknown; error: string; retained: boolean };
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

type ServerUiPrefsPushHooks = {
  afterCommit?: (commit: ServerUiPrefsCommit) => void;
  profileId?: string | null;
  canWrite?: boolean;
  profile?: Pick<ApplicationGatewaySnapshot, "selfUser" | "hello"> | null;
};
export type { ServerUiPrefProvenance, ServerUiPrefState } from "./server-prefs-state.ts";

export function resolveServerUiPrefState<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  scope = "",
  settings = loadSettings(scope || undefined),
  options: { canSync?: boolean | null; profileId?: string | null } = {},
): ServerUiPrefState<SyncedPrefValue<K>> {
  const disconnectedProfile =
    !options.profileId && isAppearancePref(key) && options.canSync === null;
  const profileId =
    options.profileId ?? (disconnectedProfile ? resolveProfileAppearanceProfileId(scope) : null);
  const effectiveScope = resolveProfilePreferenceScope(scope, profileId);
  const shadowPrefs =
    effectiveScope === outbox.pendingScope
      ? outbox.pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, effectiveScope));
  const profilePrefs = resolveProfileAppearancePrefs(scope, profileId);
  const pendingAppearance = profileId && isAppearancePref(key) && profilePrefs === null;
  // The boot mirror is still compared with its last server appearance while
  // loading. This merged baseline does not identify which values came from the profile.
  const appearanceSnapshot = pendingAppearance
    ? (parseStoredPrefs(readStorage(LAST_SEEN_KEY, effectiveScope)) ?? {})
    : profilePrefs;
  const state = resolveServerUiPrefStateFromSnapshot(
    configObject,
    key,
    shadowPrefs,
    settings,
    options.canSync,
    appearanceSnapshot,
  );
  return pendingAppearance && state.provenance === "profile"
    ? { ...state, provenance: "synced" }
    : state;
}
const CONFLICT_REDRAIN_DELAY_MS = 1_000;
const MAX_CONFLICT_REDRAINS = 5;
class ServerUiPrefsOutbox {
  applyingServerPrefs = false;
  pendingScope = "";
  pendingPrefs: ServerUiPrefs | null = null;
  pendingPersistedKeys = new Set<SyncedPrefKey>();
  pushWriter: ServerUiPrefsWriter | null = null;
  pushScope = "";
  pushProfileId: string | null = null;
  pushCanWrite = false;
  pushAfterCommit: ((commit: ServerUiPrefsCommit) => void) | undefined;
  pushDraining = false;
  drainRequested = false;
  pushEpoch = 0;
  conflictRedrainTimer: ReturnType<typeof setTimeout> | null = null;
  consecutiveConflictRedrains = 0;
  lastReconciledScope = "";
  // Reusing an immutable pre-commit config snapshot after lastSeen moves would
  // revert acknowledged edits. Only new objects or explicit invalidations reconcile.
  lastReconciledConfigObject: unknown = null;
  preferenceWriteFailures = new Map<string, Map<SyncedPrefKey, PreferenceWriteFailure>>();
  writePendingStorage = writePendingStorage;
  recordPreferenceWriteFailures = recordPreferenceWriteFailures;
  reconcilePersistedPendingPrefs = reconcilePersistedPendingPrefs;
  cancelPendingKeys = cancelPendingKeys;
  updateRetainedLocalKeys = updateRetainedLocalKeys;
  publishPreferenceWrites = publishPreferenceWrites;
  clearConflictRedrain = clearConflictRedrain;
  scheduleConflictRedrain = scheduleConflictRedrain;
  mergePendingIntoStorage = mergePendingIntoStorage;
  startPendingDrain = startPendingDrain;
}
// Keep one object alive across lazy dispatch, resets, and connection changes.
const outbox = new ServerUiPrefsOutbox();
export { outbox as serverUiPrefsOutbox };
export type { ServerUiPrefsOutbox };

// Callers select current intent and publish only after their related state is settled.
function recordPreferenceWriteFailures(
  scope: string,
  values: ServerUiPrefs,
  error: unknown,
  retained = false,
): void {
  const failures = outbox.preferenceWriteFailures.get(scope) ?? new Map();
  for (const key of Object.keys(values) as SyncedPrefKey[]) {
    failures.set(key, {
      value: values[key],
      error: error instanceof Error ? error.message : String(error),
      retained,
    });
  }
  outbox.preferenceWriteFailures.set(scope, failures);
}

function clearConflictRedrain(): void {
  if (outbox.conflictRedrainTimer !== null) {
    clearTimeout(outbox.conflictRedrainTimer);
    outbox.conflictRedrainTimer = null;
  }
  outbox.consecutiveConflictRedrains = 0;
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
  if (retained && scope === outbox.lastReconciledScope) {
    outbox.lastReconciledConfigObject = null;
  }
}
function adoptPendingScope(scope: string, force = false): void {
  if (!force && scope === outbox.pendingScope) {
    return;
  }
  outbox.pendingScope = scope;
  const stored = readStoredPrefs(PENDING_KEY, scope);
  outbox.pendingPrefs = stored.prefs;
  outbox.pendingPersistedKeys = new Set(
    stored.available && stored.prefs ? (Object.keys(stored.prefs) as SyncedPrefKey[]) : [],
  );
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  const persisted = writeStorage(
    PENDING_KEY,
    outbox.pendingScope,
    prefs ? JSON.stringify(prefs) : null,
  );
  if (persisted) {
    outbox.pendingPersistedKeys = new Set(
      outbox.pendingPrefs ? (Object.keys(outbox.pendingPrefs) as SyncedPrefKey[]) : [],
    );
  } else {
    outbox.pendingPersistedKeys.clear();
  }
}
function cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void {
  for (const key of keys) {
    outbox.preferenceWriteFailures.get(scope)?.delete(key);
  }
  if (scope === outbox.pendingScope) {
    reconcilePersistedPendingPrefs();
  }
  const active = scope === outbox.pendingScope ? outbox.pendingPrefs : null;
  const remaining = {
    ...parseStoredPrefs(readStorage(PENDING_KEY, scope)),
    ...active,
  };
  for (const key of keys) {
    delete remaining[key];
  }
  const next = Object.keys(remaining).length ? remaining : null;
  if (scope === outbox.pendingScope) {
    outbox.pendingPrefs = next;
    writePendingStorage(next);
    return;
  }
  writeStorage(PENDING_KEY, scope, next ? JSON.stringify(next) : null);
}
// localStorage pending is a cross-tab merged pool per gateway. Per-key read-merge-write prevents
// one tab from clobbering sibling offline intent; its ms-scale race is accepted because storage has
// no CAS and the drain converges through server-side LWW.
function mergePendingIntoStorage(ackedBatch: ServerUiPrefs = {}): void {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, outbox.pendingScope)) ?? {};
  for (const key of Object.keys(ackedBatch) as SyncedPrefKey[]) {
    if (prefValuesEqual(stored[key], ackedBatch[key])) {
      delete stored[key];
    }
  }
  const merged = { ...stored, ...outbox.pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
// Only persisted keys participate in cross-tab reconciliation. An in-memory-only key means
// localStorage was unavailable, so absence from storage cannot be interpreted as cancellation.
function reconcilePersistedPendingPrefs(): void {
  if (!outbox.pendingPrefs || outbox.pendingPersistedKeys.size === 0) {
    return;
  }
  const stored = readStoredPrefs(PENDING_KEY, outbox.pendingScope);
  if (!stored.available) {
    return;
  }
  const current = stored.prefs ?? {};
  for (const key of outbox.pendingPersistedKeys) {
    if (!Object.hasOwn(current, key)) {
      delete outbox.pendingPrefs[key];
      outbox.pendingPersistedKeys.delete(key);
      continue;
    }
    const storedValue = current[key];
    if (!prefValuesEqual(outbox.pendingPrefs[key], storedValue)) {
      (outbox.pendingPrefs as Record<string, unknown>)[key] = storedValue;
    }
  }
  if (!Object.keys(outbox.pendingPrefs).length) {
    outbox.pendingPrefs = null;
  }
}
export function resetServerUiPrefsSync() {
  clearConflictRedrain();
  outbox.applyingServerPrefs = outbox.pushDraining = outbox.drainRequested = false;
  outbox.pendingScope = "";
  outbox.pendingPrefs = outbox.pushWriter = null;
  outbox.pendingPersistedKeys.clear();
  outbox.pushScope = "";
  outbox.pushProfileId = null;
  outbox.pushCanWrite = false;
  outbox.lastReconciledScope = "";
  outbox.lastReconciledConfigObject = null;
  resetProfileAppearancePrefs();
  resetServerUiPrefIntent();
  outbox.preferenceWriteFailures.clear();
  outbox.pushEpoch += 1;
  publishPreferenceWrites();
}

export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    profileId?: string | null;
    onApplied: (patch: Partial<UiSettings>) => void;
    onThemeChanged?: (theme: ThemeName | null) => void;
  },
): boolean {
  const gatewayScope = hooks.scope ?? "";
  rememberProfileAppearanceIdentity(gatewayScope, hooks.profileId ?? null);
  const scope = resolveProfilePreferenceScope(gatewayScope, hooks.profileId);
  if (scope === outbox.lastReconciledScope && configObject === outbox.lastReconciledConfigObject) {
    return false;
  }
  // Last-seen state is per profile scope but the rendered settings are a
  // singleton: after an identity switch (A→B→A) an unchanged last-seen does not
  // mean the DOM shows this profile's values, so a switch between two known
  // scopes forces a full reconcile. Boot keeps the shortcut (mirror is current).
  const scopeChanged = outbox.lastReconciledScope !== "" && scope !== outbox.lastReconciledScope;
  const profilePrefs = resolveProfileAppearancePrefs(gatewayScope, hooks.profileId);
  // A known identity switch keeps the existing full reset; its mirror belongs
  // to the previous identity. Only defer a pending profile within the same scope.
  const appearanceReady = !hooks.profileId || profilePrefs !== null || scopeChanged;
  // Gateway config has no authority over anonymous browser-only background choices.
  const backgroundReady = Boolean(hooks.profileId && profilePrefs !== null);
  const shadowPrefs =
    scope === outbox.pendingScope
      ? outbox.pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const retainedLocalKeys = readRetainedLocalKeys(scope);
  const reconciledRetainedKeys = [...retainedLocalKeys].filter(
    (key) => appearanceReady || !isAppearancePref(key),
  );
  const finishReconciliation = () => {
    if (reconciledRetainedKeys.length) {
      updateRetainedLocalKeys(scope, reconciledRetainedKeys, false);
    }
    outbox.lastReconciledScope = scope;
    outbox.lastReconciledConfigObject = configObject;
  };
  const prefs = { ...extractServerUiPrefs(configObject), ...profilePrefs };
  if (
    backgroundReady &&
    profilePrefs?.background === undefined &&
    loadSettings(gatewayScope || undefined).background !== undefined
  ) {
    // Confirmed absence clears an old mirror. Pending identity never erases its
    // own private boot mirror, and untouched profiles need no synthetic record.
    prefs.background = null;
  }
  const lastSeenRaw = readStorage(LAST_SEEN_KEY, scope);
  const lastSeen = parseStoredPrefs(lastSeenRaw) ?? {};
  if (!appearanceReady) {
    // A pending profile is not an empty profile. Keep its mirror and last-seen
    // appearance until the profile can confirm overrides or Gateway fallbacks.
    for (const key of SYNCED_PREF_KEYS) {
      if (isAppearancePref(key)) {
        delete prefs[key];
        if (Object.hasOwn(lastSeen, key)) {
          Object.assign(prefs, { [key]: lastSeen[key] });
        }
      }
    }
  }
  const key = JSON.stringify(prefs);
  if (!scopeChanged && key === lastSeenRaw) {
    finishReconciliation();
    return false;
  }
  const changed = serverUiPrefsSnapshotDelta(prefs, lastSeen, {
    appearanceReady,
    scopeChanged,
    firstSnapshot: lastSeenRaw === null,
    shadowPrefs,
    retainedLocalKeys,
  });
  if (!backgroundReady) {
    delete changed.background;
  }
  writeStorage(LAST_SEEN_KEY, scope, key);
  finishReconciliation();
  if (Object.hasOwn(changed, "theme")) {
    hooks.onThemeChanged?.(changed.theme ?? null);
  }
  const patch = serverPrefsLocalPatch(changed, loadSettings(gatewayScope || undefined));
  if (!patch) {
    return false;
  }
  outbox.applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    outbox.applyingServerPrefs = false;
  }
  hooks.onApplied(patch);
  return true;
}

export async function refreshProfileAppearancePrefs(options: {
  client: GatewayBrowserClient;
  profileId: string;
  configObject: unknown;
  scope?: string;
  onApplied: (patch: Partial<UiSettings>) => void;
  onThemeChanged?: (theme: ThemeName | null) => void;
}): Promise<boolean> {
  const scope = options.scope ?? options.client.gatewayUrl;
  if (!(await loadProfileAppearancePrefs(options.client, options.profileId, scope))) {
    return false;
  }
  outbox.lastReconciledConfigObject = null;
  return applyServerUiPrefs(options.configObject, { ...options, scope });
}
export function isApplyingServerUiPrefs(): boolean {
  return outbox.applyingServerPrefs;
}
function adoptPushWriter(writer: ServerUiPrefsWriter, hooks: ServerUiPrefsPushHooks): void {
  const gatewayScope = writer.state.client?.gatewayUrl ?? "";
  const profileId =
    hooks.profileId ??
    hooks.profile?.selfUser?.id ??
    (!writer.state.connected ? resolveProfileAppearanceProfileId(gatewayScope) : null);
  if (profileId || writer.state.connected) {
    rememberProfileAppearanceIdentity(gatewayScope, profileId);
  }
  const scope = resolveProfilePreferenceScope(gatewayScope, profileId);
  outbox.pushCanWrite =
    hooks.canWrite ?? hasOperatorWriteAccess(hooks.profile?.hello?.auth ?? null);
  if (
    outbox.pushWriter === writer &&
    outbox.pushScope === scope &&
    outbox.pushProfileId === profileId
  ) {
    return;
  }
  // Reconcile the scope being left before moving pre-connection intent forward.
  // Otherwise another tab can cancel storage while this realm later resurrects its stale memory.
  reconcilePersistedPendingPrefs();
  const unscopedPending =
    outbox.pendingScope === ""
      ? {
          ...parseStoredPrefs(readStorage(PENDING_KEY, "")),
          ...outbox.pendingPrefs,
        }
      : null;
  clearConflictRedrain();
  outbox.pushEpoch += 1;
  outbox.pushWriter = writer;
  outbox.pushScope = scope;
  outbox.pushProfileId = profileId;
  outbox.pushDraining = false;
  adoptPendingScope(scope, true);
  if (scope && unscopedPending && Object.keys(unscopedPending).length) {
    // A preference can be edited before the first gateway client is adopted.
    // Move only that unscoped intent forward; preferences from one real
    // gateway must never bleed into another gateway's scope.
    outbox.pendingPrefs = { ...outbox.pendingPrefs, ...unscopedPending };
    mergePendingIntoStorage();
    writeStorage(PENDING_KEY, "", null);
  }
}
// Conflicts mean another writer committed, so bounded rescheduling converges under progress.
// The cap prevents an endlessly conflicting server from keeping a timer chain alive.
function scheduleConflictRedrain(writer: ServerUiPrefsWriter, epoch: number): void {
  if (
    outbox.conflictRedrainTimer !== null ||
    outbox.consecutiveConflictRedrains >= MAX_CONFLICT_REDRAINS
  ) {
    return;
  }
  outbox.consecutiveConflictRedrains += 1;
  outbox.conflictRedrainTimer = setTimeout(() => {
    outbox.conflictRedrainTimer = null;
    if (outbox.pushWriter === writer && outbox.pushEpoch === epoch && outbox.pendingPrefs) {
      startPendingDrain(writer);
    }
  }, CONFLICT_REDRAIN_DELAY_MS);
}

function startPendingDrain(writer: ServerUiPrefsWriter): void {
  // Offline intent stays queued; it must not invalidate another profile while loading dispatch.
  if (!writer.state.connected) {
    return;
  }
  if (outbox.pushDraining) {
    outbox.drainRequested = true;
    return;
  }
  if (!outbox.pendingPrefs) {
    return;
  }
  if (
    writer.state.connected &&
    writer.canPatch === false &&
    !(
      outbox.pushProfileId &&
      outbox.pushCanWrite &&
      Object.keys(outbox.pendingPrefs).some(isAppearancePref)
    )
  ) {
    return;
  }
  outbox.pushDraining = true;
  const epoch = outbox.pushEpoch;
  void import("./server-prefs-drain.ts")
    .then(({ drainPendingPrefs }) => drainPendingPrefs(outbox, writer, epoch))
    .catch((error: unknown) => {
      if (outbox.pushWriter !== writer || outbox.pushEpoch !== epoch || !outbox.pendingPrefs) {
        return;
      }
      recordPreferenceWriteFailures(outbox.pendingScope, outbox.pendingPrefs, error);
      publishPreferenceWrites();
    })
    .finally(() => {
      if (outbox.pushWriter === writer && outbox.pushEpoch === epoch) {
        outbox.pushDraining = false;
        if (outbox.drainRequested) {
          outbox.drainRequested = false;
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
  outbox.pushAfterCommit = hooks.afterCommit;
  const keys = SYNCED_PREF_KEYS.filter((key) => Object.hasOwn(prefs, key));
  for (const key of keys) {
    outbox.preferenceWriteFailures.get(outbox.pendingScope)?.delete(key);
  }
  const blockedKeys = writer.state.connected
    ? keys.filter((key) => {
        if (SYNCED_PREFS[key].configSync === false && !outbox.pushProfileId) {
          return true;
        }
        if (outbox.pushProfileId && isAppearancePref(key)) {
          // Imported custom palettes are browser-local by contract; a profile
          // must never carry a theme another browser cannot render.
          return !outbox.pushCanWrite || (key === "theme" && prefs.theme === "custom");
        }
        return writer.canPatch === false;
      })
    : [];
  if (blockedKeys.length) {
    // A connected read-only edit is intentionally browser-local. Supersede only
    // same-key offline intent so a later authorization cannot replay stale input.
    cancelPendingKeys(outbox.pendingScope, blockedKeys);
    updateRetainedLocalKeys(outbox.pendingScope, blockedKeys, true);
    publishPreferenceWrites();
    hooks.afterCommit?.({ needsRefresh: false, retainedLocal: true });
    if (blockedKeys.length === keys.length) {
      return;
    }
  }
  updateRetainedLocalKeys(
    outbox.pendingScope,
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
  reconcilePersistedPendingPrefs();
  outbox.pendingPrefs = { ...outbox.pendingPrefs, ...writablePrefs };
  mergePendingIntoStorage();
  publishPreferenceWrites();
  startPendingDrain(writer);
}
export function flushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  hooks: ServerUiPrefsPushHooks = {},
): void {
  adoptPushWriter(writer, hooks);
  clearConflictRedrain();
  outbox.pushEpoch += 1;
  outbox.pushDraining = outbox.drainRequested = false;
  outbox.pushAfterCommit = hooks.afterCommit;
  startPendingDrain(writer);
}
