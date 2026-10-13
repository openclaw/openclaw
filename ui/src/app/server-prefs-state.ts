import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeBackgroundPreference,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { normalizeTabIconPreference } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { isThemeId, normalizeThemeMode } from "../../../packages/gateway-protocol/src/theme-ids.ts";
import { DEFAULT_SIDEBAR_ENTRIES, normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  normalizeAccentColor,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
  type ChatSendShortcut,
  type UiSettings,
} from "./settings-contract.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
import { normalizeTypefaceOverride } from "./typography.ts";

export function isAppearancePref(key: string): key is keyof typeof UI_APPEARANCE_PREFERENCE_KEYS {
  return Object.hasOwn(UI_APPEARANCE_PREFERENCE_KEYS, key);
}

export const UI_NAVIGATION_PREFERENCE_KEYS = {
  sidebarEntries: "ui.railShortcuts",
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
  local: (settings: UiSettings) => T | undefined;
  write?: (value: T | undefined) => Partial<UiSettings>;
  canApply?: (value: T, settings: UiSettings) => boolean;
};

const prefSpec = <T>(specification: SyncedPrefSpec<T>) => specification;

const optionalPrefSpec = <
  K extends "accent" | "fontUi" | "fontChat" | "tabIcon" | "chatFollowUpMode",
>(
  key: K,
  normalize: (value: unknown) => UiSettings[K],
  configSync = true,
) =>
  prefSpec<UiSettings[K]>({
    configSync,
    extract: normalize,
    local: (settings) => normalize(settings[key]),
    write: (value) => ({ [key]: value }),
  });

const booleanPrefSpec = (local: SyncedPrefSpec<boolean>["local"]) =>
  prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local,
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
    // A server "custom" theme is only honorable once this browser imported one;
    // the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: normalizeThemeMode,
    local: (settings) => settings.themeMode,
    write: (value) => ({ themeMode: value ?? UI_APPEARANCE_DEFAULTS.themeMode }),
  }),
  accent: optionalPrefSpec("accent", normalizeAccentColor),
  fontUi: optionalPrefSpec("fontUi", normalizeTypefaceOverride, false),
  fontChat: optionalPrefSpec("fontChat", normalizeTypefaceOverride, false),
  tabIcon: optionalPrefSpec("tabIcon", normalizeTabIconPreference, false),
  background: prefSpec<BackgroundPreference>({
    configSync: false,
    extract: normalizeBackgroundPreference,
    local: (settings) => normalizeBackgroundPreference(settings.background),
    write: (value) => ({ background: value }),
  }),
  locale: prefSpec<string>({
    extract: (value) => (typeof value === "string" && isSupportedLocale(value) ? value : undefined),
    local: (settings) => settings.locale,
    write: (value) => ({ locale: value }),
  }),
  chatShowThinking: booleanPrefSpec((settings) => settings.chatShowThinking),
  chatShowToolCalls: booleanPrefSpec((settings) => settings.chatShowToolCalls),
  chatPersistCommentary: booleanPrefSpec((settings) => settings.chatPersistCommentary !== false),
  chatSendShortcut: prefSpec<ChatSendShortcut>({
    extract: (value) => (value === "enter" || value === "modifier-enter" ? value : undefined),
    local: (settings) => normalizeChatSendShortcut(settings.chatSendShortcut),
    write: (value) => ({ chatSendShortcut: value }),
  }),
  // Unset uses the server-configured queue mode; clearing sends an explicit null removal.
  chatFollowUpMode: optionalPrefSpec("chatFollowUpMode", normalizeChatFollowUpModeOverride),
  sidebarEntries: prefSpec<string[]>({
    configSync: false,
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
    write: (value) => ({ sidebarEntries: value ?? [...DEFAULT_SIDEBAR_ENTRIES] }),
  }),
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
    /** Browser-only identities of the last confirmed navigation publications, never RPC entries. */
    navigationConfirmation?: Partial<Record<"sidebarEntries", string>>;
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
    return left.length === right.length && left.every((value, index) => value === right[index]);
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
