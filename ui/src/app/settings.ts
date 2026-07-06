// Control UI module implements storage behavior.
const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "openclaw.control.settings.v1";
const LOCAL_USER_IDENTITY_KEY = "openclaw.control.user.v1";
const LEGACY_TOKEN_SESSION_KEY = "openclaw.control.token.v1";
const TOKEN_SESSION_KEY_PREFIX = "openclaw.control.token.v1:";
const MAX_SCOPED_SESSION_ENTRIES = 10;

type WindowWithControlUiBasePath = Window &
  typeof globalThis & {
    [key: string]: unknown;
  };

function settingsKeyForGateway(gatewayUrl: string): string {
  return `${SETTINGS_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

type ScopedSessionSelection = {
  sessionKey: string;
  lastActiveSessionKey: string;
};

type PersistedUiSettings = Omit<UiSettings, "token" | "sessionKey" | "lastActiveSessionKey"> & {
  token?: never;
  sessionKey?: string;
  lastActiveSessionKey?: string;
  sessionsByGateway?: Record<string, ScopedSessionSelection>;
};

import {
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  normalizeSidebarPinnedRoutes,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";
import { parseImportedCustomTheme, type ImportedCustomTheme } from "./custom-theme.ts";
import { parseThemeSelection, type ThemeMode, type ThemeName } from "./theme.ts";
import {
  hasLocalUserIdentity,
  normalizeLocalUserIdentity,
  type LocalUserIdentity,
} from "./user-identity.ts";

export const BORDER_RADIUS_STOPS = [0, 25, 50, 75, 100] as const;
export type BorderRadiusStop = (typeof BORDER_RADIUS_STOPS)[number];

export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

export const CHAT_AUTO_SCROLL_MODES = ["always", "near-bottom", "off"] as const;
export type ChatAutoScrollMode = (typeof CHAT_AUTO_SCROLL_MODES)[number];

export function normalizeChatAutoScrollMode(value: unknown): ChatAutoScrollMode {
  return CHAT_AUTO_SCROLL_MODES.includes(value as ChatAutoScrollMode)
    ? (value as ChatAutoScrollMode)
    : "near-bottom";
}

export const CHAT_SEND_SHORTCUTS = ["enter", "modifier-enter"] as const;
export type ChatSendShortcut = (typeof CHAT_SEND_SHORTCUTS)[number];

export function normalizeChatSendShortcut(value: unknown): ChatSendShortcut {
  return CHAT_SEND_SHORTCUTS.includes(value as ChatSendShortcut)
    ? (value as ChatSendShortcut)
    : "enter";
}

function snapBorderRadius(value: number): BorderRadiusStop {
  let best: BorderRadiusStop = BORDER_RADIUS_STOPS[0];
  let bestDist = Math.abs(value - best);
  for (const stop of BORDER_RADIUS_STOPS) {
    const dist = Math.abs(value - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

export function normalizeTextScale(value: unknown, fallback: TextScaleStop = 100): TextScaleStop {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  let best: TextScaleStop = TEXT_SCALE_STOPS[0];
  let bestDist = Math.abs(value - best);
  for (const stop of TEXT_SCALE_STOPS) {
    const dist = Math.abs(value - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  chatPersistCommentary?: boolean;
  chatAutoScroll?: ChatAutoScrollMode;
  chatSendShortcut?: ChatSendShortcut;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (240–400px)
  sidebarPinnedRoutes: SidebarNavRoute[]; // Nav routes shown above the "More" section
  sidebarMoreExpanded: boolean; // Whether the sidebar "More" section is expanded
  borderRadius: number; // Corner roundness (0–100, default 50)
  textScale?: TextScaleStop; // Browser-local text scale percentage
  customTheme?: ImportedCustomTheme;
  locale?: string;
};

export type { LocalUserIdentity } from "./user-identity.ts";

type LastActiveSessionHost = {
  settings: UiSettings;
  applySettings(next: UiSettings): void;
};

export function setLastActiveSessionKey(host: LastActiveSessionHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed || host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  host.applySettings({ ...host.settings, lastActiveSessionKey: trimmed });
}

export type ApplicationStartupLocation = {
  pathname: string;
  search: string;
  hash: string;
};

type NativeControlAuth = {
  gatewayUrl?: string | null;
  token?: string | null;
  password?: string | null;
};

type ApplicationStartupSettings = {
  settings: UiSettings;
  password: string | null;
  pendingGatewayUrl: string | null;
  pendingGatewayToken: string | null;
  queryTokenUsed: boolean;
  location: ApplicationStartupLocation;
  changed: boolean;
};

declare global {
  interface Window {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: NativeControlAuth;
  }
}

export function resolveApplicationStartupSettings(
  initialSettings: UiSettings,
  location: ApplicationStartupLocation,
): ApplicationStartupSettings {
  let settings = initialSettings;
  let changed = false;
  let password: string | null = null;
  let pendingGatewayUrl: string | null = null;
  let pendingGatewayToken: string | null = null;
  let queryTokenUsed = false;

  const updateSettings = (patch: Partial<UiSettings>) => {
    const entries = Object.entries(patch) as Array<
      [keyof UiSettings, UiSettings[keyof UiSettings]]
    >;
    if (entries.every(([key, value]) => settings[key] === value)) {
      return;
    }
    settings = { ...settings, ...patch };
    changed = true;
  };

  const nativeAuth =
    typeof window === "undefined" ? undefined : window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  if (nativeAuth) {
    try {
      delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    } catch {
      window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = undefined;
    }

    const gatewayUrl = normalizeOptionalString(nativeAuth.gatewayUrl);
    const token = normalizeOptionalString(nativeAuth.token);
    const nativePassword = normalizeOptionalString(nativeAuth.password);
    updateSettings({
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(token ? { token } : {}),
    });
    if (nativePassword) {
      password = nativePassword;
    }
  }

  if (!location.search && !location.hash) {
    return {
      settings,
      password,
      pendingGatewayUrl,
      pendingGatewayToken,
      queryTokenUsed,
      location,
      changed,
    };
  }

  const url = new URL(
    `${location.pathname}${location.search}${location.hash}`,
    "http://openclaw.local",
  );
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = normalizeOptionalString(gatewayUrlRaw) ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== settings.gatewayUrl);
  const queryToken = params.get("token");
  const hashToken = hashParams.get("token");
  const hasTokenParam = hashToken != null || queryToken != null;
  const token = normalizeOptionalString(hashToken ?? queryToken);
  const session = normalizeOptionalString(params.get("session") ?? hashParams.get("session"));
  const shouldResetSessionForToken = Boolean(token && !session && !gatewayUrlChanged);
  let shouldCleanUrl = false;

  if (params.has("token")) {
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (hasTokenParam) {
    if (queryToken != null) {
      queryTokenUsed = true;
      console.warn(
        "[openclaw] Auth token passed as query parameter (?token=). Use URL fragment instead: #token=<token>. Query parameters may appear in server logs.",
      );
    }
    if (token && gatewayUrlChanged) {
      pendingGatewayToken = token;
    } else if (token) {
      updateSettings({ token });
    }
    hashParams.delete("token");
    shouldCleanUrl = true;
  }

  if (shouldResetSessionForToken) {
    updateSettings({
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (params.has("password") || hashParams.has("password")) {
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  if (session) {
    updateSettings({
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  if (gatewayUrlRaw != null) {
    pendingGatewayUrl = gatewayUrlChanged ? nextGatewayUrl : null;
    if (!gatewayUrlChanged) {
      pendingGatewayToken = null;
    }
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (shouldCleanUrl) {
    url.search = params.toString();
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }

  return {
    settings,
    password,
    pendingGatewayUrl,
    pendingGatewayToken,
    queryTokenUsed,
    location: shouldCleanUrl
      ? {
          pathname: url.pathname,
          search: url.search,
          hash: url.hash,
        }
      : location,
    changed,
  };
}

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function formatHostWithPort(hostname: string, port: string): string {
  const normalizedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${normalizedHost}:${port}`;
}

function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const configured =
    typeof window !== "undefined" &&
    normalizeOptionalString(
      (window as WindowWithControlUiBasePath)["__OPENCLAW_CONTROL_UI_BASE_PATH__"],
    );
  const basePath = configured
    ? normalizeBasePath(configured)
    : inferBasePathFromPathname(location.pathname);
  const pageUrl = `${proto}://${location.host}${basePath}`;
  if (!isViteDevPage()) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  const effectiveUrl = `${proto}://${formatHostWithPort(location.hostname, "18789")}`;
  return { pageUrl, effectiveUrl };
}

function getSessionStorage(): Storage | null {
  return getSafeSessionStorage();
}

function normalizeGatewayTokenScope(gatewayUrl: string): string {
  const trimmed = normalizeOptionalString(gatewayUrl) ?? "";
  if (!trimmed) {
    return "default";
  }
  try {
    const base =
      typeof location !== "undefined"
        ? `${location.protocol}//${location.host}${location.pathname || "/"}`
        : undefined;
    const parsed = base ? new URL(trimmed, base) : new URL(trimmed);
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "") || parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return trimmed;
  }
}

function tokenSessionKeyForGateway(gatewayUrl: string): string {
  return `${TOKEN_SESSION_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

function resolveScopedSessionSelection(
  gatewayUrl: string,
  parsed: PersistedUiSettings,
  fallback: ScopedSessionSelection,
): ScopedSessionSelection {
  const scope = normalizeGatewayTokenScope(gatewayUrl);
  const scoped = parsed.sessionsByGateway?.[scope];
  const scopedSessionKey = normalizeOptionalString(scoped?.sessionKey);
  const scopedLastActiveSessionKey = normalizeOptionalString(scoped?.lastActiveSessionKey);
  if (scopedSessionKey && scopedLastActiveSessionKey) {
    return {
      sessionKey: scopedSessionKey,
      lastActiveSessionKey: scopedLastActiveSessionKey,
    };
  }

  const legacySessionKey = normalizeOptionalString(parsed.sessionKey) ?? fallback.sessionKey;
  const legacyLastActiveSessionKey =
    normalizeOptionalString(parsed.lastActiveSessionKey) ??
    legacySessionKey ??
    fallback.lastActiveSessionKey;

  return {
    sessionKey: legacySessionKey,
    lastActiveSessionKey: legacyLastActiveSessionKey,
  };
}

export function loadGatewaySessionSelection(gatewayUrl: string): ScopedSessionSelection {
  const fallback = { sessionKey: "main", lastActiveSessionKey: "main" };
  try {
    const storage = getSafeLocalStorage();
    const raw =
      storage?.getItem(settingsKeyForGateway(gatewayUrl)) ?? storage?.getItem(LEGACY_SETTINGS_KEY);
    return raw
      ? resolveScopedSessionSelection(gatewayUrl, JSON.parse(raw) as PersistedUiSettings, fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

function loadSessionToken(gatewayUrl: string): string {
  try {
    const storage = getSessionStorage();
    if (!storage) {
      return "";
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const token = storage.getItem(tokenSessionKeyForGateway(gatewayUrl));
    return normalizeOptionalString(token) ?? "";
  } catch {
    return "";
  }
}

export function resolveGatewayTokenForUrlEdit(
  currentGatewayUrl: string,
  nextGatewayUrl: string,
  currentToken: string,
): string {
  if (
    normalizeGatewayTokenScope(currentGatewayUrl) === normalizeGatewayTokenScope(nextGatewayUrl)
  ) {
    return currentToken;
  }
  // Gateway tokens stay session-scoped across endpoint edits.
  // Durable settings may contain scrubbed legacy tokens, but must not restore them here.
  return loadSessionToken(nextGatewayUrl);
}

function persistSessionToken(gatewayUrl: string, token: string) {
  try {
    const storage = getSessionStorage();
    if (!storage) {
      return;
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const key = tokenSessionKeyForGateway(gatewayUrl);
    const normalized = normalizeOptionalString(token) ?? "";
    if (normalized) {
      storage.setItem(key, normalized);
      return;
    }
    storage.removeItem(key);
  } catch {
    // best-effort
  }
}

export function loadSettings(): UiSettings {
  const { pageUrl: pageDerivedUrl, effectiveUrl: defaultUrl } = deriveDefaultGatewayUrl();
  const storage = getSafeLocalStorage();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: loadSessionToken(defaultUrl),
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: false,
    chatAutoScroll: "near-bottom",
    chatSendShortcut: "enter",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    sidebarPinnedRoutes: [...DEFAULT_SIDEBAR_PINNED_ROUTES],
    sidebarMoreExpanded: false,
    borderRadius: 50,
    textScale: 100,
  };

  try {
    // First check for legacy key (no scope), then check for scoped key
    const scopedKey = settingsKeyForGateway(defaults.gatewayUrl);
    const raw =
      storage?.getItem(scopedKey) ??
      storage?.getItem(SETTINGS_KEY_PREFIX + "default") ??
      storage?.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as PersistedUiSettings;
    const parsedGatewayUrl = normalizeOptionalString(parsed.gatewayUrl) ?? defaults.gatewayUrl;
    const gatewayUrl = parsedGatewayUrl === pageDerivedUrl ? defaultUrl : parsedGatewayUrl;
    const scopedSessionSelection = resolveScopedSessionSelection(gatewayUrl, parsed, defaults);
    const customTheme = parseImportedCustomTheme((parsed as { customTheme?: unknown }).customTheme);
    const { theme, mode } = parseThemeSelection(
      (parsed as { theme?: unknown }).theme,
      (parsed as { themeMode?: unknown }).themeMode,
    );
    const settings: UiSettings = {
      gatewayUrl,
      // Gateway auth is intentionally in-memory only; scrub any legacy persisted token on load.
      token: loadSessionToken(gatewayUrl),
      sessionKey: scopedSessionSelection.sessionKey,
      lastActiveSessionKey: scopedSessionSelection.lastActiveSessionKey,
      theme: theme === "custom" && !customTheme ? "claw" : theme,
      themeMode: mode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      chatShowToolCalls:
        typeof parsed.chatShowToolCalls === "boolean"
          ? parsed.chatShowToolCalls
          : defaults.chatShowToolCalls,
      chatPersistCommentary:
        typeof parsed.chatPersistCommentary === "boolean"
          ? parsed.chatPersistCommentary
          : defaults.chatPersistCommentary,
      chatAutoScroll: normalizeChatAutoScrollMode(parsed.chatAutoScroll),
      chatSendShortcut: normalizeChatSendShortcut(parsed.chatSendShortcut),
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navWidth:
        typeof parsed.navWidth === "number" && parsed.navWidth >= 200 && parsed.navWidth <= 400
          ? parsed.navWidth
          : defaults.navWidth,
      sidebarPinnedRoutes:
        normalizeSidebarPinnedRoutes(parsed.sidebarPinnedRoutes) ?? defaults.sidebarPinnedRoutes,
      sidebarMoreExpanded:
        typeof parsed.sidebarMoreExpanded === "boolean"
          ? parsed.sidebarMoreExpanded
          : defaults.sidebarMoreExpanded,
      borderRadius:
        typeof parsed.borderRadius === "number" &&
        parsed.borderRadius >= 0 &&
        parsed.borderRadius <= 100
          ? snapBorderRadius(parsed.borderRadius)
          : defaults.borderRadius,
      textScale: normalizeTextScale(parsed.textScale, defaults.textScale),
      customTheme: customTheme ?? undefined,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
    };
    if ("token" in parsed) {
      persistSettings(settings);
    }
    return settings;
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  persistSettings(next);
}

export function patchSettings(patch: Partial<UiSettings>): UiSettings {
  const next = { ...loadSettings(), ...patch };
  persistSettings(next);
  return next;
}

export function loadLocalUserIdentity(): LocalUserIdentity {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_USER_IDENTITY_KEY);
    if (!raw) {
      return normalizeLocalUserIdentity();
    }
    return normalizeLocalUserIdentity(JSON.parse(raw) as Partial<LocalUserIdentity>);
  } catch {
    return normalizeLocalUserIdentity();
  }
}

export function saveLocalUserIdentity(next: LocalUserIdentity) {
  const storage = getSafeLocalStorage();
  const normalized = normalizeLocalUserIdentity(next);
  try {
    if (!hasLocalUserIdentity(normalized)) {
      storage?.removeItem(LOCAL_USER_IDENTITY_KEY);
      return;
    }
    storage?.setItem(LOCAL_USER_IDENTITY_KEY, JSON.stringify(normalized));
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory identity updates from being applied
  }
}

function persistSettings(next: UiSettings) {
  persistSessionToken(next.gatewayUrl, next.token);
  const storage = getSafeLocalStorage();
  const scope = normalizeGatewayTokenScope(next.gatewayUrl);
  const scopedKey = settingsKeyForGateway(next.gatewayUrl);
  let existingSessionsByGateway: Record<string, ScopedSessionSelection> = {};
  try {
    // Try to migrate from legacy key or other scopes
    const raw =
      storage?.getItem(scopedKey) ??
      storage?.getItem(SETTINGS_KEY_PREFIX + "default") ??
      storage?.getItem("openclaw.control.settings.v1");
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedUiSettings;
      if (parsed.sessionsByGateway && typeof parsed.sessionsByGateway === "object") {
        existingSessionsByGateway = parsed.sessionsByGateway;
      }
    }
  } catch {
    // best-effort
  }
  const sessionsByGateway = Object.fromEntries(
    [
      ...Object.entries(existingSessionsByGateway).filter(([key]) => key !== scope),
      [
        scope,
        {
          sessionKey: next.sessionKey,
          lastActiveSessionKey: next.lastActiveSessionKey,
        },
      ],
    ].slice(-MAX_SCOPED_SESSION_ENTRIES),
  );
  const persisted: PersistedUiSettings = {
    gatewayUrl: next.gatewayUrl,
    theme: next.theme,
    themeMode: next.themeMode,
    chatShowThinking: next.chatShowThinking,
    chatShowToolCalls: next.chatShowToolCalls,
    chatPersistCommentary: next.chatPersistCommentary ?? false,
    chatAutoScroll: normalizeChatAutoScrollMode(next.chatAutoScroll),
    ...(normalizeChatSendShortcut(next.chatSendShortcut) === "modifier-enter"
      ? { chatSendShortcut: "modifier-enter" as const }
      : {}),
    splitRatio: next.splitRatio,
    navCollapsed: next.navCollapsed,
    navWidth: next.navWidth,
    sidebarPinnedRoutes: next.sidebarPinnedRoutes,
    sidebarMoreExpanded: next.sidebarMoreExpanded,
    borderRadius: next.borderRadius,
    textScale: normalizeTextScale(next.textScale),
    ...(next.customTheme ? { customTheme: next.customTheme } : {}),
    sessionsByGateway,
    ...(next.locale ? { locale: next.locale } : {}),
  };
  const serialized = JSON.stringify(persisted);
  try {
    storage?.setItem(scopedKey, serialized);
    storage?.setItem(LEGACY_SETTINGS_KEY, serialized);
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory settings and visual updates from being applied
  }
}
