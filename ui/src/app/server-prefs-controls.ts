// Appearance-only controls operate on the canonical outbox; startup does not load them.
import {
  normalizeBackgroundPreference,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { requestServerUiPrefReset, requestServerUiPrefWrite } from "./server-prefs-intent.ts";
import {
  invalidateProfileAppearanceReads,
  recordProfileAppearanceCommit,
  resolveProfileAppearanceProfileId,
  resolveProfilePreferenceScope,
} from "./server-prefs-profile.ts";
import {
  type ResettableServerUiPrefKey,
  type ServerUiPrefState,
  type SyncedPrefValue,
  isAppearancePref,
  prefValuesEqual,
  SYNCED_PREFS,
  type SyncedPrefKey,
} from "./server-prefs-state.ts";
import {
  LAST_SEEN_KEY,
  PENDING_KEY,
  parseStoredPrefs,
  readRetainedLocalKeys,
  readStorage,
  writeStorage,
} from "./server-prefs-storage.ts";
import { serverUiPrefsOutbox as outbox } from "./server-prefs.ts";
import type { UiSettings } from "./settings.ts";
import { loadSettings, patchSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";
import { invalidateUserPreferences } from "./user-prefs-cache.ts";

/** Transport failures stay attached to the exact pending intent, never a newer edit. */
export function resolveServerUiPrefWriteStatus(
  key: SyncedPrefKey,
  scope: string,
  profileId?: string | null,
): { status: "saved" | "pending" | "error"; error?: string } {
  const identity = profileId ?? resolveProfileAppearanceProfileId(scope);
  const effectiveScope = resolveProfilePreferenceScope(scope, identity);
  const pending =
    effectiveScope === outbox.pendingScope
      ? outbox.pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, effectiveScope));
  const failure = outbox.preferenceWriteFailures.get(effectiveScope)?.get(key);
  const currentValue =
    pending && Object.hasOwn(pending, key)
      ? pending[key]
      : (SYNCED_PREFS[key].local(loadSettings(scope || undefined)) ?? null);
  if (failure && prefValuesEqual(failure.value, currentValue)) {
    return { status: "error", error: failure.error };
  }
  if (pending && Object.hasOwn(pending, key)) {
    return { status: "pending" };
  }
  if (readRetainedLocalKeys(effectiveScope).has(key)) {
    return { status: "error", error: "This preference is saved only on this device." };
  }
  return { status: "saved" };
}

/**
 * Adopt a users.background mutation receipt without enqueueing users.prefs.set.
 * The caller captures expectedPreference before dispatch and owns request/connection
 * currency through isCurrent. Upload/removal must wait for background status "saved".
 */
export function adoptCommittedBackgroundPreference(options: {
  client: GatewayBrowserClient;
  profileId: string;
  scope?: string;
  preference: BackgroundPreference | null;
  expectedPreference: BackgroundPreference | null;
  isCurrent: () => boolean;
}): boolean {
  const scope = options.scope ?? options.client.gatewayUrl;
  if (
    !options.isCurrent() ||
    !options.client.connected ||
    resolveProfileAppearanceProfileId(scope) !== options.profileId
  ) {
    return false;
  }
  const background =
    options.preference === null ? undefined : normalizeBackgroundPreference(options.preference);
  if (options.preference !== null && !background) {
    return false;
  }
  const effectiveScope = resolveProfilePreferenceScope(scope, options.profileId);
  if (effectiveScope === outbox.pendingScope) {
    outbox.reconcilePersistedPendingPrefs();
  }
  const pending =
    effectiveScope === outbox.pendingScope
      ? outbox.pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, effectiveScope));
  const current = loadSettings(scope).background;
  if (
    (pending && Object.hasOwn(pending, "background")) ||
    (!prefValuesEqual(current, options.expectedPreference ?? undefined) &&
      !prefValuesEqual(current, background))
  ) {
    // A delayed receipt must not cancel or overwrite newer local intent.
    return false;
  }
  invalidateProfileAppearanceReads();
  invalidateUserPreferences(options.client);
  recordProfileAppearanceCommit(scope, options.profileId, { background: background ?? null });
  const lastSeen = parseStoredPrefs(readStorage(LAST_SEEN_KEY, effectiveScope)) ?? {};
  if (background) {
    lastSeen.background = background;
  } else {
    delete lastSeen.background;
  }
  writeStorage(LAST_SEEN_KEY, effectiveScope, JSON.stringify(lastSeen));
  outbox.preferenceWriteFailures.get(effectiveScope)?.delete("background");
  outbox.updateRetainedLocalKeys(effectiveScope, ["background"], false);
  outbox.lastReconciledConfigObject = null;
  const wasApplying = outbox.applyingServerPrefs;
  outbox.applyingServerPrefs = true;
  try {
    patchSettings({ gatewayUrl: scope, background }, { selectGateway: false });
  } finally {
    outbox.applyingServerPrefs = wasApplying;
  }
  outbox.publishPreferenceWrites();
  return true;
}

/** Retry current intent through the adopted writer, retaining its target and commit hooks. */
export function retryServerUiPrefWrite(
  key: SyncedPrefKey,
  scope: string,
  profileId?: string | null,
): boolean {
  const writer = outbox.pushWriter;
  const identity = profileId === undefined ? resolveProfileAppearanceProfileId(scope) : profileId;
  const effectiveScope = resolveProfilePreferenceScope(scope, identity);
  if (
    !writer?.state.connected ||
    !writer.state.client?.connected ||
    writer.state.client.gatewayUrl !== scope ||
    outbox.pushScope !== effectiveScope ||
    outbox.pendingScope !== effectiveScope ||
    outbox.pushProfileId !== identity ||
    resolveProfileAppearanceProfileId(scope) !== identity
  ) {
    return false;
  }
  const specification = SYNCED_PREFS[key];
  const value = specification.local(loadSettings(scope));
  if (
    identity && isAppearancePref(key)
      ? !outbox.pushCanWrite || (key === "theme" && value === "custom")
      : specification.configSync === false || writer.canPatch === false
  ) {
    return false;
  }
  outbox.reconcilePersistedPendingPrefs();
  const hasPending = outbox.pendingPrefs !== null && Object.hasOwn(outbox.pendingPrefs, key);
  const failure = outbox.preferenceWriteFailures.get(effectiveScope)?.get(key);
  const retryValue = hasPending ? outbox.pendingPrefs?.[key] : (value ?? null);
  if (
    (retryValue === null && !specification.write) ||
    (retryValue !== null && !prefValuesEqual(retryValue, value)) ||
    (!hasPending &&
      !(failure?.retained && prefValuesEqual(failure.value, retryValue)) &&
      !readRetainedLocalKeys(effectiveScope).has(key))
  ) {
    // A sibling cancellation or newer edit is not permission to resurrect old intent.
    return false;
  }
  outbox.preferenceWriteFailures.get(effectiveScope)?.delete(key);
  outbox.updateRetainedLocalKeys(effectiveScope, [key], false);
  outbox.pendingPrefs = { ...outbox.pendingPrefs, [key]: retryValue };
  outbox.mergePendingIntoStorage();
  outbox.clearConflictRedrain();
  outbox.publishPreferenceWrites();
  outbox.startPendingDrain(writer);
  return true;
}

export function resetServerUiPref<K extends ResettableServerUiPrefKey>(
  key: K,
  state?: ServerUiPrefState<SyncedPrefValue<K>>,
  scope = outbox.pendingScope,
  profileId?: string | null,
): UiSettings {
  const specification = SYNCED_PREFS[key];
  const applyReset = (patch: Partial<UiSettings>) =>
    key === "theme" && patch.theme !== undefined
      ? selectThemeSettings(patch.theme)
      : patchSettings(patch);
  // Disconnected clients retain their last known profile for local cancellation.
  const activeProfile = isAppearancePref(key)
    ? (profileId ?? resolveProfileAppearanceProfileId(scope))
    : null;
  const effectiveScope = resolveProfilePreferenceScope(scope, activeProfile);
  // SAFETY: SYNCED_PREFS pairs each key's write() with that key's own value type.
  const write = specification.write as
    | ((value: SyncedPrefValue<K> | undefined) => Partial<UiSettings>)
    | undefined;
  if (!write) {
    throw new Error(`Server UI preference is not resettable: ${key}`);
  }
  if (state?.provenance === "device-local") {
    const patch = write(state.resetValue);
    const keys: SyncedPrefKey[] =
      key === "theme" && patch.theme !== loadSettings().theme
        ? [key, "accent", "fontUi", "fontChat"]
        : [key];
    outbox.cancelPendingKeys(effectiveScope, keys);
    // Edits made after disconnect lose the profile and queue in the Gateway scope.
    if (effectiveScope !== scope) {
      outbox.cancelPendingKeys(scope, keys);
    }
    outbox.updateRetainedLocalKeys(effectiveScope, keys, false);
    for (const resetKey of keys) {
      requestServerUiPrefReset(resetKey, "device-local");
    }
    return applyReset(patch);
  }
  requestServerUiPrefReset(key, "server");
  // The resolved state owns the reset target, including the Gateway fallback
  // while the profile is still loading. Config preferences use product defaults.
  return applyReset(write(state?.resetValue));
}

/** Explicit user selection only; incoming snapshots and mode changes never reset design choices. */
export function selectThemeSettings(
  theme: ThemeName,
  patch: Pick<Partial<UiSettings>, "customTheme"> = {},
): UiSettings {
  if (theme === loadSettings().theme) {
    return patchSettings({ ...patch, theme });
  }
  // Clear even unresolved profile values: a missing boot mirror is not evidence
  // that the server has no font override. Send these with the theme in one batch.
  // Carry the whole selection intent even if another tab already mirrors this
  // marker, so a read-only selection can cancel every older queued design edit.
  requestServerUiPrefWrite("accent");
  requestServerUiPrefReset("fontUi", "server");
  requestServerUiPrefReset("fontChat", "server");
  return patchSettings({
    ...patch,
    theme,
    fontUi: undefined,
    fontChat: undefined,
    accent: "theme",
  });
}
