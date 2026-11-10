import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeBackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { normalizeTabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import {
  UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY,
  UI_RAIL_SHORTCUTS_PREFERENCE_KEY,
  UI_SIDEBAR_AGENT_ORDER_PREFERENCE_KEY,
} from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.ts";
import { isThemeId, normalizeThemeMode } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { DEFAULT_SIDEBAR_ENTRIES, normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { normalizePersonalSessionGroups } from "../lib/sessions/personal-groups.ts";
import {
  normalizeAccentColor,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  normalizeSidebarAgentOrder,
  UI_APPEARANCE_DEFAULTS,
  type ChatSendShortcut,
  type UiPreferences,
  type UiSettings,
} from "./settings-contract.ts";
import { normalizeTypefaceOverride } from "./typography.ts";

export function isAppearancePref(key: string): key is keyof typeof UI_APPEARANCE_PREFERENCE_KEYS {
  return Object.hasOwn(UI_APPEARANCE_PREFERENCE_KEYS, key);
}

export const UI_NAVIGATION_PREFERENCE_KEYS = {
  sidebarEntries: UI_RAIL_SHORTCUTS_PREFERENCE_KEY,
  sidebarAgentOrder: UI_SIDEBAR_AGENT_ORDER_PREFERENCE_KEY,
  personalSessionGroups: UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY,
} as const;

export function isNavigationPref(key: string): key is keyof typeof UI_NAVIGATION_PREFERENCE_KEYS {
  return Object.hasOwn(UI_NAVIGATION_PREFERENCE_KEYS, key);
}

export function isProfilePref(key: string): boolean {
  return isAppearancePref(key) || isNavigationPref(key);
}

type SyncedPrefSpec<T> = {
  configSync?: boolean;
  extract: (value: unknown) => T | undefined;
  local: (settings: UiPreferences) => T | undefined;
  write?: (value: T | undefined) => Partial<UiSettings>;
  canApply?: (value: T, settings: UiPreferences) => boolean;
};

const valuePrefSpec = <
  K extends
    | "theme"
    | "themeMode"
    | "accent"
    | "fontUi"
    | "fontChat"
    | "tabIcon"
    | "chatFollowUpMode"
    | "background"
    | "locale",
>(
  key: K,
  normalize: (value: unknown) => UiSettings[K] | undefined,
  configSync = true,
  defaultValue?: UiSettings[K],
): SyncedPrefSpec<UiSettings[K]> => ({
  configSync,
  extract: normalize,
  local: (settings) => settings[key],
  write: (value) => ({ [key]: value ?? defaultValue }),
});

const booleanPrefSpec = (local: SyncedPrefSpec<boolean>["local"]): SyncedPrefSpec<boolean> => ({
  extract: (value) => (typeof value === "boolean" ? value : undefined),
  local,
});

const navigationPrefSpec = <K extends keyof typeof UI_NAVIGATION_PREFERENCE_KEYS>(
  key: K,
  normalize: (value: unknown) => UiSettings[K] | null,
  defaults: NonNullable<UiSettings[K]>,
): SyncedPrefSpec<NonNullable<UiSettings[K]>> => ({
  configSync: false,
  extract: (value) => normalize(value) ?? undefined,
  local: (settings) => settings[key] ?? defaults,
  write: (value) => ({ [key]: value ?? [...defaults] }),
});

const chatSendShortcutPref: SyncedPrefSpec<ChatSendShortcut> = {
  extract: (value) => (value === "enter" || value === "modifier-enter" ? value : undefined),
  local: (settings) => normalizeChatSendShortcut(settings.chatSendShortcut),
  write: (value) => ({ chatSendShortcut: value }),
};

/**
 * One descriptor per synced pref, including its profile-only storage boundary.
 * Each key owns server validation, local normalization, and applicability.
 */
export const SYNCED_PREFS = {
  theme: {
    ...valuePrefSpec(
      "theme",
      (value) => (value === "custom" || isThemeId(value) ? value : undefined),
      true,
      UI_APPEARANCE_DEFAULTS.theme,
    ),
    // A server "custom" theme is only honorable once this browser imported one;
    // the imported palette itself is too large to live in config.
    canApply: (value: UiSettings["theme"], settings: UiPreferences) =>
      value !== "custom" || Boolean(settings.customTheme),
  },
  themeMode: valuePrefSpec("themeMode", normalizeThemeMode, true, UI_APPEARANCE_DEFAULTS.themeMode),
  accent: valuePrefSpec("accent", normalizeAccentColor),
  fontUi: valuePrefSpec("fontUi", normalizeTypefaceOverride, false),
  fontChat: valuePrefSpec("fontChat", normalizeTypefaceOverride, false),
  tabIcon: valuePrefSpec("tabIcon", normalizeTabIconPreference, false),
  background: valuePrefSpec("background", normalizeBackgroundPreference, false),
  locale: valuePrefSpec("locale", (value) =>
    typeof value === "string" && isSupportedLocale(value) ? value : undefined,
  ),
  chatShowThinking: booleanPrefSpec((settings) => settings.chatShowThinking),
  chatShowToolCalls: booleanPrefSpec((settings) => settings.chatShowToolCalls),
  chatPersistCommentary: booleanPrefSpec((settings) => settings.chatPersistCommentary !== false),
  chatSendShortcut: chatSendShortcutPref,
  // Unset uses the server-configured queue mode; clearing sends an explicit null removal.
  chatFollowUpMode: valuePrefSpec("chatFollowUpMode", normalizeChatFollowUpModeOverride),
  personalSessionGroups: navigationPrefSpec(
    "personalSessionGroups",
    normalizePersonalSessionGroups,
    [],
  ),
  sidebarAgentOrder: navigationPrefSpec("sidebarAgentOrder", normalizeSidebarAgentOrder, []),
  sidebarEntries: navigationPrefSpec("sidebarEntries", normalizeSidebarEntries, [
    ...DEFAULT_SIDEBAR_ENTRIES,
  ]),
} as const;

export type SyncedPrefKey = keyof typeof SYNCED_PREFS;
export type ResettableServerUiPrefKey =
  | "theme"
  | "themeMode"
  | "accent"
  | "fontUi"
  | "fontChat"
  | "tabIcon"
  | "background"
  | "locale"
  | "chatSendShortcut"
  | "chatFollowUpMode";
export type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;
export type SyncedServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };
// Browser storage can retain unknown keys until authoritative rejection; known fields stay typed.
export type ServerUiPrefs = SyncedServerUiPrefs &
  Record<string, unknown> & {
    /** Browser-only edit base: the observed snapshot with subsequent authored membership operations folded in. */
    sidebarEntriesBase?: readonly string[];
    /** Browser-only: an unacknowledged authored reorder, including a reversal back to the edit base. */
    sidebarEntriesOrder?: true;
  };
export function clearSidebarEntriesMetadata(prefs: ServerUiPrefs): void {
  delete prefs.sidebarEntriesBase;
  delete prefs.sidebarEntriesOrder;
}
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
    return (
      left.length === right.length &&
      left.every((value, index) => prefValuesEqual(value, right[index]))
    );
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord && rightRecord) {
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every(
        (key) =>
          Object.hasOwn(rightRecord, key) && prefValuesEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return left === right;
}

export type ServerUiPrefReadiness = {
  appearanceReady: boolean;
  navigationReady?: boolean;
};

const PROFILE_PREFERENCE_KEYS = {
  ...UI_APPEARANCE_PREFERENCE_KEYS,
  ...UI_NAVIGATION_PREFERENCE_KEYS,
};
export const PROFILE_UI_PREFERENCE_KEYS = Object.values(PROFILE_PREFERENCE_KEYS);

export function extractProfileUiPrefs(entries: Record<string, unknown>): ServerUiPrefs {
  const prefs: ServerUiPrefs = {};
  for (const [key, preferenceKey] of Object.entries(PROFILE_PREFERENCE_KEYS)) {
    const value = isAppearancePref(key)
      ? normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS[key], entries[preferenceKey])
      : isNavigationPref(key)
        ? SYNCED_PREFS[key].extract(entries[preferenceKey])
        : undefined;
    if (value !== undefined) {
      Object.assign(prefs, { [key]: value });
    }
  }
  return prefs;
}
