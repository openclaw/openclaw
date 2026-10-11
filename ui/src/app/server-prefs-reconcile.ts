// Loaded when a real config snapshot is available, not by the synchronous edit/outbox seam.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { readConfirmedPrefs, publishConfirmedPrefs } from "./server-prefs-confirmation.ts";
import {
  rememberProfileAppearanceIdentity,
  resolveProfileAppearancePrefs,
  resolveProfileAppearanceProfileId,
  resolveProfilePreferenceScope,
  profilePreferencesState,
  type ProfilePreferencesReadOptions,
} from "./server-prefs-profile.ts";
import {
  SYNCED_PREFS,
  SYNCED_PREF_KEYS,
  isAppearancePref,
  isNavigationPref,
  isProfilePref,
  prefValuesEqual,
  type SyncedPrefKey,
  type SyncedPrefValue,
  type ServerUiPrefs,
  type SyncedServerUiPrefs,
  type ServerUiPrefState,
  type ServerUiPrefReadiness,
} from "./server-prefs-state.ts";
import {
  PENDING_KEY,
  parseStoredPrefs,
  readStorage,
  readRetainedLocalKeys,
} from "./server-prefs-storage.ts";
import { serverUiPrefsOutbox as sync } from "./server-prefs.ts";
import type { UiSettings } from "./settings-contract.ts";
import {
  loadSettings,
  loadUiPreferences,
  readSettingsForGateway,
  profileNavigation,
} from "./settings.ts";
import type { ThemeName } from "./theme.ts";

function applyChangedSettingsPatch(
  target: Partial<UiSettings>,
  settings: UiSettings,
  source: Partial<UiSettings>,
): void {
  const applyKey = <K extends keyof UiSettings>(key: K, value: UiSettings[K] | undefined) => {
    if (!prefValuesEqual(settings[key], value)) {
      target[key] = value;
    }
  };
  // SAFETY: source contains only UiSettings fields produced by the synced descriptor write methods.
  for (const key of Object.keys(source) as Array<keyof UiSettings>) {
    applyKey(key, source[key]);
  }
}

export function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  if (!prefs) {
    return {};
  }
  const result: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (SYNCED_PREFS[key].configSync === false) {
      continue;
    }
    const value = SYNCED_PREFS[key].extract(prefs[key]);
    if (value !== undefined) {
      // SAFETY: this descriptor extracted the value for the same key being assigned.
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function resolveServerUiPrefStateFromSnapshot<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  shadowPrefs: ServerUiPrefs | null,
  settings: UiSettings,
  canSync?: boolean | null,
  profilePrefs?: SyncedServerUiPrefs | null,
): ServerUiPrefState<SyncedPrefValue<K>> {
  const specification = SYNCED_PREFS[key];
  // SAFETY: specification is SYNCED_PREFS[key]; its local and extract methods own the same value type.
  const localValue = specification.local(settings) as SyncedPrefValue<K> | undefined;
  const resetPatch = specification.write?.(undefined);
  const defaultValue = resetPatch ? specification.local({ ...settings, ...resetPatch }) : undefined;
  // SAFETY: the same key descriptor writes its default and reads it back through local().
  const productDefault = defaultValue as SyncedPrefValue<K> | undefined;
  const localState = (
    resetValue: SyncedPrefValue<K> | undefined,
  ): ServerUiPrefState<SyncedPrefValue<K>> => {
    const overridden = !prefValuesEqual(localValue, resetValue);
    return {
      overridden,
      provenance:
        overridden || (specification.configSync === false && canSync === false)
          ? "device-local"
          : "default",
      resetValue,
      value: localValue,
    };
  };
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  const extractedConfigValue =
    specification.configSync !== false && prefs && Object.hasOwn(prefs, key)
      ? specification.extract(prefs[key])
      : undefined;
  // SAFETY: extraction validates the value with the exact descriptor selected by key K.
  const configValue = extractedConfigValue as SyncedPrefValue<K> | undefined;
  const profileValue = profilePrefs?.[key] ?? undefined;
  const serverValue = profileValue ?? configValue;
  const isProfileValue = profileValue !== undefined;
  // With a profile active, reset deletes the profile key (even when none exists
  // yet), so the reset target is what that deletion falls back to — the gateway
  // value. Using the product default here misclassifies an explicit selection of
  // the product default as a reset and silently drops the user's choice.
  const resetsProfileKey = profilePrefs != null && isAppearancePref(key);
  const resetValue = resetsProfileKey ? (configValue ?? productDefault) : productDefault;
  const canApplyServerValue =
    serverValue !== undefined &&
    (!specification.canApply ||
      // SAFETY: serverValue is selected from this key descriptor; canApply belongs to that same key.
      (specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      ));
  const applicableServerValue = canApplyServerValue ? serverValue : productDefault;
  if (
    (canSync === null && profilePrefs != null && isAppearancePref(key)) ||
    (canSync === false && shadowPrefs && key in shadowPrefs)
  ) {
    // Disconnected profiles and read-only queued edits use the last server
    // baseline without claiming a pending sync or creating another remote write.
    return { ...localState(applicableServerValue), provenance: "device-local" };
  }
  if (shadowPrefs && key in shadowPrefs) {
    const shadowValue = shadowPrefs[key];
    if (shadowValue === null) {
      return { ...localState(resetValue), provenance: "pending" };
    }
    return {
      overridden: true,
      provenance: "pending",
      resetValue,
      // SAFETY: ServerUiPrefs maps each pending key K to its corresponding SyncedPrefValue<K>.
      value: shadowValue as SyncedPrefValue<K>,
    };
  }
  if (serverValue === undefined || (!canApplyServerValue && canSync === false)) {
    return localState(productDefault);
  }
  if (!canApplyServerValue || prefValuesEqual(localValue, serverValue)) {
    // Preserve authored server provenance even when this browser cannot render
    // the value, so Restore default still removes the server override.
    return {
      overridden: true,
      provenance: isProfileValue ? "profile" : "synced",
      resetValue,
      value: canApplyServerValue ? serverValue : localValue,
    };
  }
  return localState(serverValue);
}

function isServerUiPrefReady(
  key: SyncedPrefKey,
  { appearanceReady, navigationReady = appearanceReady }: ServerUiPrefReadiness,
): boolean {
  return isNavigationPref(key) ? navigationReady : appearanceReady || !isAppearancePref(key);
}

function serverUiPrefsSnapshotDelta(
  prefs: ServerUiPrefs,
  lastSeen: ServerUiPrefs,
  {
    appearanceReady,
    navigationReady = appearanceReady,
    scopeChanged,
    firstSnapshot,
    shadowPrefs,
    retainedLocalKeys,
  }: {
    appearanceReady: boolean;
    navigationReady?: boolean;
    scopeChanged: boolean;
    firstSnapshot: boolean;
    shadowPrefs: ServerUiPrefs | null;
    retainedLocalKeys: ReadonlySet<SyncedPrefKey>;
  },
): ServerUiPrefs {
  const changed: ServerUiPrefs = {};
  // Apply per field: only keys whose server value changed since last seen. Reapplying unchanged
  // fields would revert unpushable local edits whenever any other server field moves.
  for (const prefKey of SYNCED_PREF_KEYS) {
    if ((shadowPrefs && prefKey in shadowPrefs) || retainedLocalKeys.has(prefKey)) {
      continue;
    }
    const ready = isServerUiPrefReady(prefKey, {
      appearanceReady,
      navigationReady,
    });
    if (Object.hasOwn(prefs, prefKey)) {
      if (
        ready &&
        (scopeChanged || firstSnapshot || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey]))
      ) {
        Object.assign(changed, { [prefKey]: prefs[prefKey] });
      }
    } else if (
      !(prefKey in prefs) &&
      SYNCED_PREFS[prefKey].write &&
      ((ready && Object.hasOwn(lastSeen, prefKey)) || (scopeChanged && isAppearancePref(prefKey)))
    ) {
      // A new identity also clears appearance values absent from its last-seen
      // snapshot, so it never inherits the previous identity's rendered look.
      changed[prefKey] = null;
    }
  }
  return changed;
}

function serverPrefsLocalPatch(
  prefs: ServerUiPrefs,
  settings: UiSettings,
  publishNavigationReset: boolean,
): Partial<UiSettings> | null {
  const patch: Partial<UiSettings> = {};
  for (const key of SYNCED_PREF_KEYS) {
    const specification = SYNCED_PREFS[key];
    const serverValue = prefs[key];
    const forcePublish = publishNavigationReset && isNavigationPref(key);
    if (serverValue === undefined) {
      continue;
    }
    if (serverValue === null) {
      const resetPatch = specification.write?.(undefined);
      if (resetPatch) {
        if (forcePublish) {
          Object.assign(patch, resetPatch);
        } else {
          applyChangedSettingsPatch(patch, settings, resetPatch);
        }
      }
      continue;
    }
    if (!forcePublish && prefValuesEqual(serverValue, specification.local(settings))) {
      continue;
    }
    if (
      specification.canApply &&
      // SAFETY: the preference map and descriptor use the same key, preserving canApply input type.
      !(specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      )
    ) {
      continue;
    }
    // SAFETY: SYNCED_PREFS keys are UiSettings keys with matching extracted values.
    (patch as Record<string, unknown>)[key] = serverValue;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Profile navigation uses profile snapshots; profileless navigation remains browser-owned. */
function reconcileNavigationSnapshot(
  prefs: ServerUiPrefs,
  lastSeen: ServerUiPrefs,
  profilePrefs: ServerUiPrefs | null,
  shadowPrefs: ServerUiPrefs | null,
  hasProfile: boolean,
  identityChanged: boolean,
  localNavigation: ReturnType<typeof loadLocalNavigationPreferences> = null,
  retainedLocalKeys: ReadonlySet<SyncedPrefKey> = new Set(),
): ServerUiPrefs {
  const changed: ServerUiPrefs = {};
  if (!hasProfile) {
    // Retired shared-config mirrors are not authority to reset browser-owned shortcuts.
    delete lastSeen.sidebarEntries;
  } else if (profilePrefs === null) {
    // Incomplete reads retain confirmed profile values, never inferred absence.
    delete prefs.sidebarEntries;
    if (Object.hasOwn(lastSeen, "sidebarEntries")) {
      prefs.sidebarEntries = lastSeen.sidebarEntries;
    }
  } else if (!Object.hasOwn(prefs, "sidebarEntries")) {
    prefs.sidebarEntries = [...DEFAULT_SIDEBAR_ENTRIES];
  }
  if (identityChanged) {
    const confirmedDelta =
      profilePrefs !== null &&
      !retainedLocalKeys.has("sidebarEntries") &&
      !prefValuesEqual(prefs.sidebarEntries, lastSeen.sidebarEntries);
    changed.sidebarEntries =
      shadowPrefs?.sidebarEntries ??
      (localNavigation && !confirmedDelta
        ? localNavigation.sidebarEntries
        : (prefs.sidebarEntries ?? null));
  }
  return changed;
}

function retainPendingAppearanceSnapshot(
  prefs: ServerUiPrefs,
  lastSeen: ServerUiPrefs,
  ready: boolean,
): void {
  if (ready) {
    return;
  }
  // Pending is not empty: retain confirmed appearance until profile coverage arrives.
  for (const key of SYNCED_PREF_KEYS.filter(isAppearancePref)) {
    delete prefs[key];
    if (Object.hasOwn(lastSeen, key)) {
      Object.assign(prefs, { [key]: lastSeen[key] });
    }
  }
}
export function resolveServerUiPrefState<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  scope = "",
  settings = loadSettings(scope || undefined),
  options: { canSync?: boolean | null; profileId?: string | null } = {},
): ServerUiPrefState<SyncedPrefValue<K>> {
  const disconnectedProfile = !options.profileId && isProfilePref(key) && options.canSync === null;
  const profileId =
    options.profileId ?? (disconnectedProfile ? resolveProfileAppearanceProfileId(scope) : null);
  const effectiveScope = resolveProfilePreferenceScope(scope, profileId);
  const shadowPrefs =
    effectiveScope === sync.pendingScope
      ? sync.pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, effectiveScope));
  const profilePrefs = resolveProfileAppearancePrefs(scope, profileId);
  const pendingAppearance = profileId && isProfilePref(key) && profilePrefs === null;
  // The boot mirror is still compared with its last server appearance while
  // loading. This merged baseline does not identify which values came from the profile.
  const appearanceSnapshot = pendingAppearance
    ? (readConfirmedPrefs(sync, effectiveScope) ?? {})
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
export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    profileId?: string | null;
    onApplied: (patch: Partial<UiSettings>) => void;
    onThemeChanged?: (theme: ThemeName | null) => void;
    /** Only a successful profile read confirms navigation; cached reapplication does not. */
    navigationConfirmed?: boolean;
  },
): boolean {
  const gatewayScope = hooks.scope ?? "";
  rememberProfileAppearanceIdentity(gatewayScope, hooks.profileId ?? null);
  const scope = resolveProfilePreferenceScope(gatewayScope, hooks.profileId);
  if (
    !hooks.navigationConfirmed &&
    scope === sync.lastReconciledScope &&
    configObject === sync.lastReconciledConfigObject
  ) {
    return false;
  }
  // Last-seen state is per profile scope but the rendered settings are a
  // singleton: after an identity switch (A→B→A) an unchanged last-seen does not
  // mean the DOM shows this profile's values, so a switch between two known
  // scopes forces a full reconcile. Boot keeps the shortcut (mirror is current).
  const scopeChanged = sync.lastReconciledScope !== null && scope !== sync.lastReconciledScope;
  const profilePrefs = resolveProfileAppearancePrefs(gatewayScope, hooks.profileId);
  const readiness = resolveProfilePreferenceReadiness(gatewayScope, hooks.profileId, scopeChanged);
  const backgroundReady = Boolean(hooks.profileId && profilePrefs !== null);
  const shadowPrefs =
    scope === sync.pendingScope
      ? sync.pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const retainedLocalKeys = readRetainedLocalKeys(scope);
  const reconciledRetainedKeys = [...retainedLocalKeys].filter((key) =>
    isServerUiPrefReady(key, readiness),
  );
  const finishReconciliation = () => {
    if (reconciledRetainedKeys.length) {
      sync.updateRetainedLocalKeys(scope, reconciledRetainedKeys, false);
    }
    sync.lastReconciledScope = scope;
    sync.lastReconciledConfigObject = configObject;
  };
  const prefs = { ...extractServerUiPrefs(configObject), ...profilePrefs };
  if (
    backgroundReady &&
    profilePrefs?.background === undefined &&
    loadSettings(gatewayScope || undefined).background !== undefined
  ) {
    // Confirmed absence clears only the current profile's private mirror.
    prefs.background = null;
  }
  const lastSeenSnapshot = readConfirmedPrefs(sync, scope);
  const lastSeen = { ...lastSeenSnapshot };
  delete lastSeen.navigationConfirmation;
  if (hooks.profileId && !hooks.navigationConfirmed) {
    // Config/appearance application cannot publish a stale profile cache over a sibling read.
    const confirmed = SYNCED_PREFS.sidebarEntries.extract(lastSeen.sidebarEntries);
    if (confirmed !== undefined) {
      prefs.sidebarEntries = confirmed;
    }
  }
  if (hooks.navigationConfirmed) {
    // Local retention covers the old/unknown baseline, not a newer confirmed navigation value.
    if (
      isServerUiPrefReady("sidebarEntries", readiness) &&
      Object.hasOwn(lastSeen, "sidebarEntries") &&
      !prefValuesEqual(prefs.sidebarEntries, lastSeen.sidebarEntries)
    ) {
      retainedLocalKeys.delete("sidebarEntries");
    }
  }
  retainPendingAppearanceSnapshot(prefs, lastSeen, readiness.appearanceReady);
  const navigationIdentityChanged = sync.lastReconciledScope !== scope;
  const navigationPatch = reconcileNavigationSnapshot(
    prefs,
    lastSeen,
    profilePrefs,
    shadowPrefs,
    Boolean(hooks.profileId),
    navigationIdentityChanged && Boolean(hooks.profileId || scopeChanged),
    loadLocalNavigationPreferences(gatewayScope, hooks.profileId),
    retainedLocalKeys,
  );
  const confirmedKeys =
    hooks.profileId && hooks.navigationConfirmed
      ? SYNCED_PREF_KEYS.filter(
          (key) => isNavigationPref(key) && isServerUiPrefReady(key, readiness),
        )
      : [];
  if (
    !navigationIdentityChanged &&
    !scopeChanged &&
    JSON.stringify(prefs) === JSON.stringify(lastSeen)
  ) {
    publishConfirmedPrefs(sync, scope, prefs, confirmedKeys);
    finishReconciliation();
    return false;
  }
  const changed = serverUiPrefsSnapshotDelta(prefs, lastSeen, {
    ...readiness,
    scopeChanged,
    firstSnapshot: lastSeenSnapshot === null,
    shadowPrefs,
    retainedLocalKeys,
  });
  if (!backgroundReady) {
    delete changed.background;
  }
  Object.assign(changed, navigationPatch);
  publishConfirmedPrefs(sync, scope, prefs, confirmedKeys);
  finishReconciliation();
  if (Object.hasOwn(changed, "theme")) {
    hooks.onThemeChanged?.(changed.theme ?? null);
  }
  // Adopting identity changes the read fallback before application snapshots are notified.
  // Publish navigation resets on first adoption too, even if that fallback equals the new defaults.
  const patch = serverPrefsLocalPatch(
    changed,
    loadSettings(gatewayScope || undefined),
    navigationIdentityChanged,
  );
  if (!patch) {
    return false;
  }
  sync.applyServerPrefsPatch(patch);
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
  isCurrent?: () => boolean;
}): Promise<boolean> {
  const scope = options.scope ?? options.client.gatewayUrl;
  const isCurrent = options.isCurrent ?? (() => true);
  if (
    !(await loadProfileAppearancePrefs(options.client, options.profileId, scope, {
      isCurrent,
    })) ||
    !isCurrent()
  ) {
    return false;
  }
  sync.lastReconciledConfigObject = null;
  return applyServerUiPrefs(options.configObject, { ...options, scope, navigationConfirmed: true });
}

function resolveProfilePreferenceReadiness(
  scope: string,
  profileId: string | null | undefined,
  scopeChanged: boolean,
): Required<ServerUiPrefReadiness> {
  const prefs = resolveProfileAppearancePrefs(scope, profileId);
  const profileReady = !profileId || prefs !== null;
  return {
    appearanceReady: profileReady || scopeChanged,
    navigationReady: profileReady,
  };
}

export async function loadProfileAppearancePrefs(
  client: GatewayBrowserClient,
  profileId: string,
  scope: string,
  options?: ProfilePreferencesReadOptions,
): Promise<boolean> {
  rememberProfileAppearanceIdentity(scope, profileId);
  const requestId = ++profilePreferencesState.requestId;
  const runtime = await import("./server-prefs-profile-runtime.ts");
  return runtime.loadProfileAppearancePrefs(
    client,
    profileId,
    scope,
    options,
    profilePreferencesState,
    requestId,
  );
}

/** Adoption restores this actor’s browser snapshot, never an inferred server default. */
function loadLocalNavigationPreferences(
  gatewayUrl: string,
  profileId?: string | null,
): ReturnType<typeof profileNavigation> {
  if (!profileId) {
    // The connection owner has adopted profileless identity before reconciliation.
    return loadUiPreferences(gatewayUrl || undefined);
  }
  try {
    return profileNavigation(
      readSettingsForGateway(getSafeLocalStorage(), gatewayUrl)?.parsed,
      profileId,
    );
  } catch {
    return null;
  }
}
