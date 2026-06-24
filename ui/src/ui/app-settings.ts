import { inferBasePathFromPathname, normalizeBasePath } from "../app-routes.ts";
// Control UI module implements app settings behavior.
import type { SettingsHost } from "../app/app-host.ts";
import { syncCustomThemeStyleTag } from "../app/custom-theme.ts";
import {
  normalizeTextScale,
  resolveApplicationStartupSettings,
  saveLocalUserIdentity,
  saveSettings,
  type LocalUserIdentity,
  type UiSettings,
} from "../app/settings.ts";
import { startThemeTransition, type ThemeTransitionContext } from "../app/theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode, type ThemeName } from "../app/theme.ts";
import { normalizeLocalUserIdentity } from "../app/user-identity.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";

type LocalUserIdentityHost = {
  userName?: string | null;
  userAvatar?: string | null;
};

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    textScale: normalizeTextScale(next.textScale),
    lastActiveSessionKey:
      normalizeOptionalString(next.lastActiveSessionKey) ??
      normalizeOptionalString(next.sessionKey) ??
      "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  syncCustomThemeStyleTag(normalized.customTheme);
  if (next.theme !== host.theme || next.themeMode !== host.themeMode) {
    host.theme = next.theme;
    host.themeMode = next.themeMode;
    applyResolvedTheme(host, resolveTheme(next.theme, next.themeMode));
  }
  applyBorderRadius(normalized.borderRadius);
  applyTextScale(normalized.textScale);
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function applyLocalUserIdentity(
  host: LocalUserIdentityHost,
  next: Partial<LocalUserIdentity>,
) {
  const normalized = normalizeLocalUserIdentity({
    name: host.userName,
    avatar: host.userAvatar,
    ...next,
  });
  host.userName = normalized.name;
  host.userAvatar = normalized.avatar;
  saveLocalUserIdentity(normalized);
}

function applySessionSelection(host: SettingsHost, session: string) {
  host.sessionKey = session;
  applySettings(host, {
    ...host.settings,
    sessionKey: session,
    lastActiveSessionKey: session,
  });
}

/** Set to true when the token is read from a query string (?token=) instead of a URL fragment. */
export let warnQueryToken = false;

export function applySettingsFromUrl(host: SettingsHost) {
  const startup = resolveApplicationStartupSettings(host.settings, {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
  if (startup.changed) {
    applySettings(host, startup.settings);
    host.sessionKey = startup.settings.sessionKey;
  }
  if (startup.password !== null) {
    host.password = startup.password;
  }
  host.pendingGatewayUrl = startup.pendingGatewayUrl;
  host.pendingGatewayToken = startup.pendingGatewayToken;
  warnQueryToken = startup.queryTokenUsed;
  if (
    startup.location.pathname !== window.location.pathname ||
    startup.location.search !== window.location.search ||
    startup.location.hash !== window.location.hash
  ) {
    const nextUrl = new URL(window.location.href);
    nextUrl.pathname = startup.location.pathname;
    nextUrl.search = startup.location.search;
    nextUrl.hash = startup.location.hash;
    updateBrowserHistory(nextUrl, true);
  }
}

function applyThemeTransition(
  host: SettingsHost,
  nextTheme: ResolvedTheme,
  applyTheme: () => void,
  context?: ThemeTransitionContext,
) {
  startThemeTransition({
    nextTheme,
    applyTheme,
    context,
    currentTheme: host.themeResolved,
  });
  syncSystemThemeListener(host);
}

export function setTheme(host: SettingsHost, next: ThemeName, context?: ThemeTransitionContext) {
  applyThemeTransition(
    host,
    resolveTheme(next, host.themeMode),
    () => applySettings(host, { ...host.settings, theme: next }),
    context,
  );
}

export function setThemeMode(
  host: SettingsHost,
  next: ThemeMode,
  context?: ThemeTransitionContext,
) {
  applyThemeTransition(
    host,
    resolveTheme(host.theme, next),
    () => applySettings(host, { ...host.settings, themeMode: next }),
    context,
  );
}

export function inferBasePath() {
  if (typeof window === "undefined") {
    return "";
  }
  const configured = window["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
  const normalizedConfigured = normalizeOptionalString(configured);
  if (normalizedConfigured) {
    return normalizeBasePath(normalizedConfigured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  syncCustomThemeStyleTag(host.settings.customTheme);
  const normalizedTheme =
    host.settings.theme === "custom" && !host.settings.customTheme
      ? "claw"
      : (host.settings.theme ?? "claw");
  host.theme = normalizedTheme;
  host.themeMode = host.settings.themeMode ?? "system";
  if (normalizedTheme !== host.settings.theme) {
    host.settings = { ...host.settings, theme: normalizedTheme };
    saveSettings(host.settings);
  }
  applyResolvedTheme(host, resolveTheme(host.theme, host.themeMode));
  applyBorderRadius(host.settings.borderRadius ?? 50);
  applyTextScale(host.settings.textScale);
  syncSystemThemeListener(host);
}

export function detachThemeListener(host: SettingsHost) {
  host.systemThemeCleanup?.();
  host.systemThemeCleanup = null;
}

const BASE_RADII = { sm: 6, md: 10, lg: 14, xl: 20, full: 9999, default: 10 };

export function applyBorderRadius(value: number) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const scale = value / 50;
  root.style.setProperty("--radius-sm", `${Math.round(BASE_RADII.sm * scale)}px`);
  root.style.setProperty("--radius-md", `${Math.round(BASE_RADII.md * scale)}px`);
  root.style.setProperty("--radius-lg", `${Math.round(BASE_RADII.lg * scale)}px`);
  root.style.setProperty("--radius-xl", `${Math.round(BASE_RADII.xl * scale)}px`);
  root.style.setProperty("--radius-full", `${Math.round(BASE_RADII.full * scale)}px`);
  root.style.setProperty("--radius", `${Math.round(BASE_RADII.default * scale)}px`);
}

export function applyTextScale(value: unknown) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const scale = normalizeTextScale(value) / 100;
  root.style.setProperty("--control-ui-text-scale", scale.toFixed(2));
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const themeMode = resolved.endsWith("light") ? "light" : "dark";
  root.dataset.theme = resolved;
  root.dataset.themeMode = themeMode;
  root.style.colorScheme = themeMode;
}

function syncSystemThemeListener(host: SettingsHost) {
  // Clean up existing listener if mode is not "system"
  if (host.themeMode !== "system") {
    host.systemThemeCleanup?.();
    host.systemThemeCleanup = null;
    return;
  }

  // Skip if listener already attached for this host
  if (host.systemThemeCleanup) {
    return;
  }

  if (typeof globalThis.matchMedia !== "function") {
    return;
  }

  const mql = globalThis.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (host.themeMode !== "system") {
      return;
    }
    applyResolvedTheme(host, resolveTheme(host.theme, "system"));
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    host.systemThemeCleanup = () => mql.removeEventListener("change", onChange);
    return;
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onChange);
    host.systemThemeCleanup = () => mql.removeListener(onChange);
  }
}

export function syncSessionWithLocation(host: SettingsHost) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  const session = normalizeOptionalString(url.searchParams.get("session"));
  if (session) {
    applySessionSelection(host, session);
  }
}

function updateBrowserHistory(url: URL, replace: boolean) {
  const history = typeof window === "undefined" ? undefined : window.history;
  if (!history) {
    return;
  }
  if (replace) {
    return history.replaceState({}, "", url.toString());
  }
  return history.pushState({}, "", url.toString());
}

export function syncUrlWithSessionKey(
  _hostValue: SettingsHost,
  sessionKey: string,
  replace: boolean,
) {
  const href = typeof window === "undefined" ? undefined : window.location?.href;
  if (!href) {
    return;
  }
  const url = new URL(href);
  url.searchParams.set("session", sessionKey);
  updateBrowserHistory(url, replace);
}
