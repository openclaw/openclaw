// Server-side operator display prefs (config ui.prefs) with a browser-local
// mirror. The config value is canonical — agents change it through the
// approval gate and other devices pick it up — while localStorage keeps
// instant boot and stays authoritative when this client cannot write config
// (viewer scope, offline). Sync policy: a server-side *change* wins over the
// local mirror; an unchanged server value never reverts local edits, so a
// failed push degrades to device-local behavior instead of flip-flopping.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  loadSettings,
  normalizeChatSendShortcut,
  normalizeTextScale,
  patchSettings,
  TEXT_SCALE_STOPS,
  type ChatSendShortcut,
  type TextScaleStop,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

export type ServerUiPrefs = {
  theme?: ThemeName;
  themeMode?: ThemeMode;
  textScale?: TextScaleStop;
  locale?: string;
  chatShowThinking?: boolean;
  chatShowToolCalls?: boolean;
  chatSendShortcut?: ChatSendShortcut;
};

const THEMES: readonly ThemeName[] = ["claw", "knot", "dash", "custom"];
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

export function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  if (!prefs) {
    return {};
  }
  const result: ServerUiPrefs = {};
  if (THEMES.includes(prefs.theme as ThemeName)) {
    result.theme = prefs.theme as ThemeName;
  }
  if (THEME_MODES.includes(prefs.themeMode as ThemeMode)) {
    result.themeMode = prefs.themeMode as ThemeMode;
  }
  if (TEXT_SCALE_STOPS.includes(prefs.textScale as TextScaleStop)) {
    result.textScale = normalizeTextScale(prefs.textScale);
  }
  if (isSupportedLocale(prefs.locale)) {
    result.locale = prefs.locale;
  }
  if (typeof prefs.chatShowThinking === "boolean") {
    result.chatShowThinking = prefs.chatShowThinking;
  }
  if (typeof prefs.chatShowToolCalls === "boolean") {
    result.chatShowToolCalls = prefs.chatShowToolCalls;
  }
  if (prefs.chatSendShortcut === "enter" || prefs.chatSendShortcut === "modifier-enter") {
    result.chatSendShortcut = normalizeChatSendShortcut(prefs.chatSendShortcut);
  }
  return result;
}

/** Local-settings patch that would bring the mirror in line with the server. */
export function serverPrefsLocalPatch(
  prefs: ServerUiPrefs,
  settings: UiSettings,
): Partial<UiSettings> | null {
  const patch: Partial<UiSettings> = {};
  // A server "custom" theme is only honorable once this browser imported one;
  // the imported palette itself is too large to live in config.
  if (prefs.theme !== undefined && prefs.theme !== settings.theme) {
    if (prefs.theme !== "custom" || settings.customTheme) {
      patch.theme = prefs.theme;
    }
  }
  if (prefs.themeMode !== undefined && prefs.themeMode !== settings.themeMode) {
    patch.themeMode = prefs.themeMode;
  }
  if (prefs.textScale !== undefined && prefs.textScale !== normalizeTextScale(settings.textScale)) {
    patch.textScale = prefs.textScale;
  }
  if (prefs.locale !== undefined && prefs.locale !== settings.locale) {
    patch.locale = prefs.locale;
  }
  if (
    prefs.chatShowThinking !== undefined &&
    prefs.chatShowThinking !== settings.chatShowThinking
  ) {
    patch.chatShowThinking = prefs.chatShowThinking;
  }
  if (
    prefs.chatShowToolCalls !== undefined &&
    prefs.chatShowToolCalls !== settings.chatShowToolCalls
  ) {
    patch.chatShowToolCalls = prefs.chatShowToolCalls;
  }
  if (
    prefs.chatSendShortcut !== undefined &&
    prefs.chatSendShortcut !== normalizeChatSendShortcut(settings.chatSendShortcut)
  ) {
    patch.chatSendShortcut = prefs.chatSendShortcut;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(
  previous: UiSettings,
  next: UiSettings,
): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  if (next.theme !== previous.theme) {
    prefs.theme = next.theme;
  }
  if (next.themeMode !== previous.themeMode) {
    prefs.themeMode = next.themeMode;
  }
  if (normalizeTextScale(next.textScale) !== normalizeTextScale(previous.textScale)) {
    prefs.textScale = normalizeTextScale(next.textScale);
  }
  if (next.locale !== previous.locale && next.locale) {
    prefs.locale = next.locale;
  }
  if (next.chatShowThinking !== previous.chatShowThinking) {
    prefs.chatShowThinking = next.chatShowThinking;
  }
  if (next.chatShowToolCalls !== previous.chatShowToolCalls) {
    prefs.chatShowToolCalls = next.chatShowToolCalls;
  }
  if (
    normalizeChatSendShortcut(next.chatSendShortcut) !==
    normalizeChatSendShortcut(previous.chatSendShortcut)
  ) {
    prefs.chatSendShortcut = normalizeChatSendShortcut(next.chatSendShortcut);
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}

// Last server value this client reconciled against. Applying only on a server
// *delta* keeps an unpushable local edit (viewer scope) from being reverted by
// every later snapshot carrying the same old server value.
let lastSeenServerPrefsKey: string | null = null;
let applyingServerPrefs = false;

export function resetServerUiPrefsSync() {
  lastSeenServerPrefsKey = null;
  applyingServerPrefs = false;
}

export function applyServerUiPrefs(
  configObject: unknown,
  hooks: { onApplied: (patch: Partial<UiSettings>) => void },
): boolean {
  const prefs = extractServerUiPrefs(configObject);
  const key = JSON.stringify(prefs);
  if (key === lastSeenServerPrefsKey) {
    return false;
  }
  lastSeenServerPrefsKey = key;
  const patch = serverPrefsLocalPatch(prefs, loadSettings());
  if (!patch) {
    return false;
  }
  applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    applyingServerPrefs = false;
  }
  hooks.onApplied(patch);
  return true;
}

export function isApplyingServerUiPrefs(): boolean {
  return applyingServerPrefs;
}

/**
 * Best-effort write-through of a local pref change to config ui.prefs.
 * Silent on failure by design: clients without operator.admin (or offline)
 * keep the change device-local. One retry absorbs a CAS hash race.
 */
export function pushServerUiPrefs(client: GatewayBrowserClient, prefs: ServerUiPrefs): void {
  void (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = (await client.request("config.get", {})) as { hash?: string } | null;
      const baseHash = snapshot?.hash;
      if (!baseHash) {
        return;
      }
      try {
        await client.request("config.patch", {
          baseHash,
          raw: JSON.stringify({ ui: { prefs } }),
          note: "control-ui prefs sync",
        });
        // Fold the pushed partial into the last-seen server value so a stale
        // snapshot (fetched before this patch) cannot revert the change.
        const lastSeen = lastSeenServerPrefsKey
          ? (JSON.parse(lastSeenServerPrefsKey) as ServerUiPrefs)
          : {};
        lastSeenServerPrefsKey = JSON.stringify(
          extractServerUiPrefs({ ui: { prefs: { ...lastSeen, ...prefs } } }),
        );
        return;
      } catch (error) {
        if (attempt === 0 && String(error).toLowerCase().includes("hash")) {
          continue;
        }
        return;
      }
    }
  })().catch(() => undefined);
}
