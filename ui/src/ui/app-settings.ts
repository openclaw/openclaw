// Control UI module implements app settings behavior.
import { applyActiveRouteTransition, refreshActiveRoute } from "../app/active-route.ts";
import type { SettingsHost } from "../app/app-host.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForRoute,
  routeIdFromPath,
  type RouteId,
} from "../routes/route-registry.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import {
  normalizeTextScale,
  saveLocalUserIdentity,
  saveSettings,
  type LocalUserIdentity,
  type UiSettings,
} from "./storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import { normalizeLocalUserIdentity } from "./user-identity.ts";

export { setLastActiveSessionKey } from "./app-last-active-session.ts";

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

declare global {
  interface Window {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: {
      gatewayUrl?: string | null;
      token?: string | null;
      password?: string | null;
    };
  }
}

function applyNativeControlAuth(host: SettingsHost) {
  const nativeAuth = window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  if (!nativeAuth) {
    return;
  }
  try {
    delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  } catch {
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = undefined;
  }

  const gatewayUrl = normalizeOptionalString(nativeAuth.gatewayUrl);
  const token = normalizeOptionalString(nativeAuth.token);
  const password = normalizeOptionalString(nativeAuth.password);
  const nextSettings = {
    ...host.settings,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(token ? { token } : {}),
  };
  if (gatewayUrl || (token && token !== host.settings.token)) {
    applySettings(host, nextSettings);
  }
  if (password && password !== host.password) {
    host.password = password;
  }
}

export function applySettingsFromUrl(host: SettingsHost) {
  applyNativeControlAuth(host);
  if (!window.location.search && !window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = normalizeOptionalString(gatewayUrlRaw) ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== host.settings.gatewayUrl);
  // Prefer fragment tokens over query tokens. Fragments avoid server-side request
  // logs and referrer leakage; query-param tokens remain a one-time legacy fallback
  // for compatibility with older deep links.
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
      warnQueryToken = true;
      console.warn(
        "[openclaw] Auth token passed as query parameter (?token=). Use URL fragment instead: #token=<token>. Query parameters may appear in server logs.",
      );
    }
    if (token && gatewayUrlChanged) {
      host.pendingGatewayToken = token;
    } else if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    hashParams.delete("token");
    shouldCleanUrl = true;
  }

  if (shouldResetSessionForToken) {
    host.sessionKey = "main";
    applySettings(host, {
      ...host.settings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (params.has("password") || hashParams.has("password")) {
    // Never hydrate password from URL params; strip only.
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  if (session) {
    applySessionSelection(host, session);
  }

  if (gatewayUrlRaw != null) {
    host.pendingGatewayUrl = gatewayUrlChanged ? nextGatewayUrl : null;
    host.pendingGatewayToken = gatewayUrlChanged ? (token ?? null) : null;
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) {
    return;
  }
  url.search = params.toString();
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  updateBrowserHistory(url, true);
}

export function setRoute(host: SettingsHost, next: RouteId) {
  applyRouteSelection(host, next, { refreshPolicy: "always", syncUrl: true });
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

export function syncRouteWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = routeIdFromPath(window.location.pathname, host.basePath) ?? "chat";
  setRouteFromLocation(host, resolved);
  syncUrlWithRoute(host, resolved, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = routeIdFromPath(window.location.pathname, host.basePath);
  if (!resolved) {
    return;
  }

  const url = new URL(window.location.href);
  const session = normalizeOptionalString(url.searchParams.get("session"));
  if (session) {
    applySessionSelection(host, session);
  }

  setRouteFromLocation(host, resolved);
}

export function setRouteFromLocation(host: SettingsHost, next: RouteId) {
  applyRouteSelection(host, next, { refreshPolicy: "connected" });
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

function applyRouteSelection(
  host: SettingsHost,
  next: RouteId,
  options: { refreshPolicy: "always" | "connected"; syncUrl?: boolean },
) {
  const prev = host.routeId;
  host.routeId = next;
  applyActiveRouteTransition(host, prev, next);

  if (options.refreshPolicy === "always" || host.connected) {
    void refreshActiveRoute(host);
  }

  if (options.syncUrl) {
    syncUrlWithRoute(host, next, false);
  }
}

export function syncUrlWithRoute(host: SettingsHost, routeId: RouteId, replace: boolean) {
  const href = typeof window === "undefined" ? undefined : window.location?.href;
  const pathname = typeof window === "undefined" ? undefined : window.location?.pathname;
  if (!href || !pathname) {
    return;
  }
  const targetPath = normalizePath(pathForRoute(routeId, host.basePath));
  const currentPath = normalizePath(pathname);
  const url = new URL(href);

  if (routeId === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  updateBrowserHistory(url, replace);
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
