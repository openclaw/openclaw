import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { isThemeId, normalizeThemeMode } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  normalizeAccentColor,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
import { normalizeTypefaceOverride, type TypefaceId } from "./typography.ts";

export function isAppearancePref(key: string): key is keyof typeof UI_APPEARANCE_PREFERENCE_KEYS {
  return Object.hasOwn(UI_APPEARANCE_PREFERENCE_KEYS, key);
}

type SyncedPrefSpec<T> = {
  configSync?: boolean;
  extract: (value: unknown) => T | undefined;
  local: (settings: UiSettings) => T | undefined;
  write?: (value: T | undefined) => Partial<UiSettings>;
  canApply?: (value: T, settings: UiSettings) => boolean;
  clearable?: boolean;
  reset?: (settings: UiSettings) => Partial<UiSettings>;
};

const prefSpec = <T>(specification: SyncedPrefSpec<T>) => specification;

const fontPrefSpec = (key: "fontUi" | "fontChat") =>
  prefSpec<TypefaceId>({
    configSync: false,
    extract: normalizeTypefaceOverride,
    local: (settings) => normalizeTypefaceOverride(settings[key]),
    write: (value) => ({ [key]: value }),
    clearable: true,
    reset: () => ({ [key]: undefined }),
  });

/**
 * One descriptor per synced pref, including its profile-only storage boundary.
 * Each key owns server validation, local normalization, and applicability.
 */
export const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (value === "custom" || isThemeId(value) ? value : undefined),
    local: (settings) => settings.theme,
    write: (value) => ({ theme: value ?? UI_APPEARANCE_DEFAULTS.theme }),
    clearable: true,
    reset: () => ({ theme: UI_APPEARANCE_DEFAULTS.theme }),
    // A server "custom" theme is only honorable once this browser imported one;
    // the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: normalizeThemeMode,
    local: (settings) => settings.themeMode,
    write: (value) => ({ themeMode: value ?? UI_APPEARANCE_DEFAULTS.themeMode }),
    clearable: true,
    reset: () => ({ themeMode: UI_APPEARANCE_DEFAULTS.themeMode }),
  }),
  accent: prefSpec<string>({
    extract: normalizeAccentColor,
    local: (settings) => normalizeAccentColor(settings.accent),
    write: (value) => ({ accent: value }),
    clearable: true,
    reset: () => ({ accent: undefined }),
  }),
  fontUi: fontPrefSpec("fontUi"),
  fontChat: fontPrefSpec("fontChat"),
  locale: prefSpec<string>({
    extract: (value) => (typeof value === "string" && isSupportedLocale(value) ? value : undefined),
    local: (settings) => settings.locale,
    write: (value) => ({ locale: value }),
    clearable: true,
    reset: () => ({ locale: undefined }),
  }),
  chatShowThinking: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatShowThinking,
  }),
  chatShowToolCalls: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatShowToolCalls,
  }),
  chatPersistCommentary: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatPersistCommentary !== false,
  }),
  chatSendShortcut: prefSpec<ChatSendShortcut>({
    extract: (value) => (value === "enter" || value === "modifier-enter" ? value : undefined),
    local: (settings) => normalizeChatSendShortcut(settings.chatSendShortcut),
    write: (value) => ({ chatSendShortcut: value }),
    clearable: true,
    reset: () => ({ chatSendShortcut: undefined }),
  }),
  chatFollowUpMode: prefSpec<ChatFollowUpMode>({
    extract: normalizeChatFollowUpModeOverride,
    local: (settings) => normalizeChatFollowUpModeOverride(settings.chatFollowUpMode),
    write: (value) => ({ chatFollowUpMode: value }),
    // Unset means "use the server-configured queue mode"; clearing must propagate,
    // so the push serializes an explicit null removal.
    clearable: true,
    reset: () => ({ chatFollowUpMode: undefined }),
  }),
  sidebarEntries: prefSpec<string[]>({
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
  }),
} as const;

export type SyncedPrefKey = keyof typeof SYNCED_PREFS;
export type ResettableServerUiPrefKey =
  | "theme"
  | "themeMode"
  | "accent"
  | "fontUi"
  | "fontChat"
  | "locale"
  | "chatSendShortcut"
  | "chatFollowUpMode";
export type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;
export type ServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };
export type ServerUiPrefProvenance = "default" | "pending" | "synced" | "profile" | "device-local";
export type ServerUiPrefState<T> = {
  overridden: boolean;
  provenance: ServerUiPrefProvenance;
  resetValue: T | undefined;
  value: T | undefined;
};

export const SYNCED_PREF_KEYS = Object.keys(SYNCED_PREFS) as SyncedPrefKey[];

export function prefValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

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
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export function resolveServerUiPrefStateFromSnapshot<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  shadowPrefs: ServerUiPrefs | null,
  settings: UiSettings,
  canSync?: boolean | null,
  profilePrefs?: ServerUiPrefs | null,
): ServerUiPrefState<SyncedPrefValue<K>> {
  const specification = SYNCED_PREFS[key];
  const localValue = specification.local(settings) as SyncedPrefValue<K> | undefined;
  const resetPatch = specification.reset?.(settings);
  const productDefault = (
    resetPatch ? specification.local({ ...settings, ...resetPatch }) : undefined
  ) as SyncedPrefValue<K> | undefined;
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
  const configValue =
    specification.configSync !== false && prefs && Object.hasOwn(prefs, key)
      ? (specification.extract(prefs[key]) as SyncedPrefValue<K> | undefined)
      : undefined;
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
      (specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      ));
  const applicableServerValue = canApplyServerValue ? serverValue : productDefault;
  if (canSync === null && profilePrefs != null && isAppearancePref(key)) {
    // Offline profile snapshots supply a local reset baseline. Cancel queued
    // edits without creating a new remote write while identity is disconnected.
    return { ...localState(applicableServerValue), provenance: "device-local" };
  }
  if (shadowPrefs && key in shadowPrefs) {
    if (canSync === false) {
      return {
        ...localState(applicableServerValue),
        // Keep queued intent for a later authorized reconnect without claiming
        // that this connected read-only browser is pending a server sync.
        provenance: "device-local",
      };
    }
    const shadowValue = shadowPrefs[key];
    if (shadowValue === null) {
      return { ...localState(resetValue), provenance: "pending" };
    }
    return {
      overridden: true,
      provenance: "pending",
      resetValue,
      value: shadowValue as SyncedPrefValue<K>,
    };
  }
  if (serverValue === undefined) {
    return localState(productDefault);
  }
  if (!canApplyServerValue) {
    if (canSync === false) {
      return localState(productDefault);
    }
    // Preserve authored server provenance even when this browser cannot render
    // the value, so Restore default still removes the server override.
    return {
      overridden: true,
      provenance: isProfileValue ? "profile" : "synced",
      resetValue,
      value: localValue,
    };
  }
  if (prefValuesEqual(localValue, serverValue)) {
    return {
      overridden: true,
      provenance: isProfileValue ? "profile" : "synced",
      resetValue,
      value: serverValue,
    };
  }
  return localState(serverValue);
}

export function serverUiPrefsSnapshotDelta(
  prefs: ServerUiPrefs,
  lastSeen: ServerUiPrefs,
  {
    appearanceReady,
    scopeChanged,
    firstSnapshot,
    shadowPrefs,
    retainedLocalKeys,
  }: {
    appearanceReady: boolean;
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
    const appearance = isAppearancePref(prefKey);
    const ready = appearanceReady || !appearance;
    if (Object.hasOwn(prefs, prefKey)) {
      if (
        ready &&
        (scopeChanged || firstSnapshot || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey]))
      ) {
        Object.assign(changed, { [prefKey]: prefs[prefKey] });
      }
    } else if (
      !(prefKey in prefs) &&
      SYNCED_PREFS[prefKey].clearable &&
      ((ready && Object.hasOwn(lastSeen, prefKey)) || (scopeChanged && appearance))
    ) {
      // A new identity also clears appearance values absent from its last-seen
      // snapshot, so it never inherits the previous identity's rendered look.
      changed[prefKey] = null;
    }
  }
  return changed;
}

/** Local-settings patch that brings the browser mirror in line with the server. */
export function serverPrefsLocalPatch(
  prefs: ServerUiPrefs,
  settings: UiSettings,
): Partial<UiSettings> | null {
  const patch: Partial<UiSettings> = {};
  for (const key of SYNCED_PREF_KEYS) {
    const specification = SYNCED_PREFS[key];
    const serverValue = prefs[key];
    if (serverValue === undefined) {
      continue;
    }
    if (serverValue === null) {
      const resetPatch = specification.clearable ? specification.reset?.(settings) : undefined;
      if (resetPatch) {
        applyChangedSettingsPatch(patch, settings, resetPatch);
      }
      continue;
    }
    if (prefValuesEqual(serverValue, specification.local(settings))) {
      continue;
    }
    if (
      specification.canApply &&
      !(specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      )
    ) {
      continue;
    }
    (patch as Record<string, unknown>)[key] = serverValue;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
