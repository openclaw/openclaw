import { loadAgents } from "./controllers/agents";
import { loadConfig, loadConfigSchema, saveConfig } from "./controllers/config";
import { loadCronJobs, loadCronStatus } from "./controllers/cron";
import { loadChannels } from "./controllers/channels";
import { loadDebug } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { loadDevices } from "./controllers/devices";
import { loadNodes } from "./controllers/nodes";
import { loadExecApprovals } from "./controllers/exec-approvals";
import { loadPresence } from "./controllers/presence";
import { loadSessions } from "./controllers/sessions";
import { loadSkills } from "./controllers/skills";
import { refreshOverseer } from "./controllers/overseer";
import {
  hashForTab,
  inferBasePathFromPathname,
  normalizeBasePath,
  parseHashRoute,
  rootPathForBasePath,
  tabFromHash,
  tabFromPath,
  type Tab,
} from "./navigation";
import { saveSettings, type UiSettings } from "./storage";
import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition";
import { jumpToLogsBottom, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import { startLogsPolling, stopLogsPolling, startDebugPolling, stopDebugPolling, startOverseerPolling, stopOverseerPolling } from "./app-polling";
import { refreshChat } from "./app-chat";
import type { ClawdbotApp } from "./app";
import { setupLogsKeyboardShortcuts } from "./views/logs";
import { setupConfigKeyboardShortcuts } from "./views/config";
import { setupOverseerKeyboardShortcuts } from "./views/overseer";
import { analyzeConfigSchema } from "./views/config-form";

/**
 * Internal type for app-settings helper functions.
 * This includes both public properties from AppViewState and internal/private
 * properties from ClawdbotApp that these helpers need to access.
 *
 * Note: Functions here are called with ClawdbotApp instances and use
 * `as unknown as ClawdbotApp` casts when they need full class access.
 */
type SettingsHost = {
  // Public properties (from AppViewState)
  settings: UiSettings;
  theme: ThemeMode;
  themeResolved: ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  logsAtBottom: boolean;
  logsAutoFollow: boolean;
  logsFilterText: string;
  logsShowRelativeTime: boolean;
  eventLog: unknown[];
  basePath: string;
  // Internal properties (private on ClawdbotApp, needed by these helpers)
  chatHasAutoScrolled: boolean;
  logsKeyboardCleanup: (() => void) | null;
  configKeyboardCleanup: (() => void) | null;
  overseerKeyboardCleanup: (() => void) | null;
  eventLogBuffer: unknown[];
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
};

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  if (next.theme !== host.theme) {
    host.theme = next.theme;
    applyResolvedTheme(host, resolveTheme(next.theme));
  }
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function setLastActiveSessionKey(host: SettingsHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed) return;
  if (host.settings.lastActiveSessionKey === trimmed) return;
  applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
}

export function applySettingsFromUrl(host: SettingsHost) {
  if (!window.location.search && !window.location.hash) return;
  const params = new URLSearchParams(window.location.search);
  const hashParams = parseHashRoute(window.location.hash).searchParams;
  const tokenRaw = params.get("token");
  const passwordRaw = params.get("password");
  const sessionRaw = params.get("session") ?? hashParams.get("session");
  const gatewayUrlRaw = params.get("gatewayUrl");
  let shouldCleanUrl = false;

  if (tokenRaw != null) {
    const token = tokenRaw.trim();
    if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (passwordRaw != null) {
    const password = passwordRaw.trim();
    if (password) {
      (host as unknown as { password: string }).password = password;
    }
    params.delete("password");
    shouldCleanUrl = true;
  }

  if (sessionRaw != null) {
    const session = sessionRaw.trim();
    if (session) {
      host.sessionKey = session;
      applySettings(host, {
        ...host.settings,
        sessionKey: session,
        lastActiveSessionKey: session,
      });
    }
  }

  if (gatewayUrlRaw != null) {
    const gatewayUrl = gatewayUrlRaw.trim();
    if (gatewayUrl && gatewayUrl !== host.settings.gatewayUrl) {
      applySettings(host, { ...host.settings, gatewayUrl });
    }
    params.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) return;
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState({}, "", url.toString());
}

export function setTab(host: SettingsHost, next: Tab) {
  if (host.tab !== next) host.tab = next;
  if (next === "chat") host.chatHasAutoScrolled = false;
  if (next === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
    setupLogsKeyboardShortcutsForHost(host);
  } else {
    stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
    cleanupLogsKeyboardShortcuts(host);
  }
  if (next === "config") {
    setupConfigKeyboardShortcutsForHost(host);
  } else {
    cleanupConfigKeyboardShortcuts(host);
  }
  if (next === "debug")
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  else stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  if (next === "overseer")
    startOverseerPolling(host as unknown as Parameters<typeof startOverseerPolling>[0]);
  else stopOverseerPolling(host as unknown as Parameters<typeof stopOverseerPolling>[0]);
  if (next === "overseer") {
    setupOverseerKeyboardShortcutsForHost(host);
  } else {
    cleanupOverseerKeyboardShortcuts(host);
  }
  void refreshActiveTab(host);
  syncUrlWithTab(host, next, false);
}

export function setTheme(
  host: SettingsHost,
  next: ThemeMode,
  context?: ThemeTransitionContext,
) {
  const applyTheme = () => {
    host.theme = next;
    applySettings(host, { ...host.settings, theme: next });
    applyResolvedTheme(host, resolveTheme(next));
  };
  startThemeTransition({
    nextTheme: next,
    applyTheme,
    context,
    currentTheme: host.theme,
  });
}

export async function refreshActiveTab(host: SettingsHost) {
  if (host.tab === "overview") await loadOverview(host);
  if (host.tab === "agents") {
    await loadSessions(host as unknown as ClawdbotApp);
  }
  if (host.tab === "channels") await loadChannelsTab(host);
  if (host.tab === "instances") await loadPresence(host as unknown as ClawdbotApp);
  if (host.tab === "sessions") {
    await Promise.all([
      loadSessions(host as unknown as ClawdbotApp),
      loadAgents(host as unknown as ClawdbotApp),
    ]);
  }
  if (host.tab === "cron") await loadCron(host);
  if (host.tab === "skills") await loadSkills(host as unknown as ClawdbotApp);
  if (host.tab === "overseer") {
    await refreshOverseer(host as unknown as ClawdbotApp);
    await Promise.all([
      loadAgents(host as unknown as ClawdbotApp),
      loadNodes(host as unknown as ClawdbotApp),
      loadSessions(host as unknown as ClawdbotApp),
      loadChannels(host as unknown as ClawdbotApp, false),
      loadPresence(host as unknown as ClawdbotApp),
      loadCron(host),
      loadSkills(host as unknown as ClawdbotApp),
    ]);
  }
  if (host.tab === "nodes") {
    await loadNodes(host as unknown as ClawdbotApp);
    await loadDevices(host as unknown as ClawdbotApp);
    await loadConfig(host as unknown as ClawdbotApp);
    await loadExecApprovals(host as unknown as ClawdbotApp);
  }
  if (host.tab === "chat") {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  }
  if (host.tab === "config") {
    await loadConfigSchema(host as unknown as ClawdbotApp);
    await loadConfig(host as unknown as ClawdbotApp);
  }
  if (host.tab === "debug") {
    await loadDebug(host as unknown as ClawdbotApp);
    host.eventLog = host.eventLogBuffer;
  }
  if (host.tab === "logs") {
    host.logsAtBottom = true;
    await loadLogs(host as unknown as ClawdbotApp, { reset: true });
    scheduleLogsScroll(
      host as unknown as Parameters<typeof scheduleLogsScroll>[0],
      true,
    );
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") return "";
  const configured = window.__CLAWDBOT_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) {
    return normalizeBasePath(configured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  host.theme = host.settings.theme ?? "system";
  applyResolvedTheme(host, resolveTheme(host.theme));
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function attachThemeListener(host: SettingsHost) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  host.themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  host.themeMediaHandler = (event) => {
    if (host.theme !== "system") return;
    applyResolvedTheme(host, event.matches ? "dark" : "light");
  };
  if (typeof host.themeMedia.addEventListener === "function") {
    host.themeMedia.addEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    addListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(host.themeMediaHandler);
}

export function detachThemeListener(host: SettingsHost) {
  if (!host.themeMedia || !host.themeMediaHandler) return;
  if (typeof host.themeMedia.removeEventListener === "function") {
    host.themeMedia.removeEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.removeListener(host.themeMediaHandler);
  host.themeMedia = null;
  host.themeMediaHandler = null;
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") return;
  const resolved =
    tabFromHash(window.location.hash) ??
    tabFromPath(window.location.pathname, host.basePath) ??
    "chat";
  setTabFromRoute(host, resolved);
  syncUrlWithTab(host, resolved, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") return;
  const resolved =
    tabFromHash(window.location.hash) ??
    tabFromPath(window.location.pathname, host.basePath);
  if (!resolved) return;

  const url = new URL(window.location.href);
  const hashSession = parseHashRoute(url.hash).searchParams.get("session")?.trim();
  const session = (url.searchParams.get("session")?.trim() || hashSession) ?? "";
  if (session) {
    host.sessionKey = session;
    applySettings(host, {
      ...host.settings,
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  setTabFromRoute(host, resolved);
}

export function setTabFromRoute(host: SettingsHost, next: Tab) {
  if (host.tab !== next) host.tab = next;
  if (next === "chat") host.chatHasAutoScrolled = false;
  if (next === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
    setupLogsKeyboardShortcutsForHost(host);
  } else {
    stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
    cleanupLogsKeyboardShortcuts(host);
  }
  if (next === "debug")
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  else stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  if (host.connected) void refreshActiveTab(host);
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const rootPath = rootPathForBasePath(host.basePath);
  const targetHash = (() => {
    const params = new URLSearchParams();
    if (tab === "chat" && host.sessionKey) params.set("session", host.sessionKey);
    return hashForTab(tab, params);
  })();

  // Canonicalize the chat session param into the hash route query so we can
  // reload and deep-link reliably on static/file hosts.
  url.searchParams.delete("session");

  if (url.pathname !== rootPath) url.pathname = rootPath;
  if (url.hash !== targetHash) url.hash = targetHash;

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(
  _host: unknown,
  sessionKey: string,
  replace: boolean,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("session");
  const params = new URLSearchParams(parseHashRoute(url.hash).searchParams);
  params.set("session", sessionKey);
  url.hash = hashForTab("chat", params);
  if (replace) window.history.replaceState({}, "", url.toString());
  else window.history.pushState({}, "", url.toString());
}

export async function loadOverview(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as ClawdbotApp, false),
    loadPresence(host as unknown as ClawdbotApp),
    loadSessions(host as unknown as ClawdbotApp),
    loadCronStatus(host as unknown as ClawdbotApp),
    loadDebug(host as unknown as ClawdbotApp),
  ]);
}

export async function loadChannelsTab(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as ClawdbotApp, true),
    loadConfigSchema(host as unknown as ClawdbotApp),
    loadConfig(host as unknown as ClawdbotApp),
  ]);
}

export async function loadCron(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as ClawdbotApp, false),
    loadCronStatus(host as unknown as ClawdbotApp),
    loadCronJobs(host as unknown as ClawdbotApp),
  ]);
}

function setupLogsKeyboardShortcutsForHost(host: SettingsHost) {
  // Clean up any existing shortcuts first
  cleanupLogsKeyboardShortcuts(host);

  host.logsKeyboardCleanup = setupLogsKeyboardShortcuts({
    onFocusSearch: () => {
      const input = document.getElementById("logs-search-input") as HTMLInputElement | null;
      input?.focus();
    },
    onJumpToBottom: () => {
      jumpToLogsBottom(host as unknown as Parameters<typeof jumpToLogsBottom>[0]);
    },
    onRefresh: () => {
      void loadLogs(host as unknown as ClawdbotApp, { reset: true });
    },
    onToggleAutoFollow: () => {
      host.logsAutoFollow = !host.logsAutoFollow;
    },
  });
}

function cleanupLogsKeyboardShortcuts(host: SettingsHost) {
  if (host.logsKeyboardCleanup) {
    host.logsKeyboardCleanup();
    host.logsKeyboardCleanup = null;
  }
}

function setupConfigKeyboardShortcutsForHost(host: SettingsHost) {
  cleanupConfigKeyboardShortcuts(host);

  const state = host as unknown as ClawdbotApp;

  host.configKeyboardCleanup = setupConfigKeyboardShortcuts({
    getFormMode: () => state.configFormMode,
    getSearchQuery: () => state.configSearchQuery,
    getCanSave: () => {
      if (!state.connected) return false;
      if (state.configSaving) return false;
      if (state.configLoading) return false;

      const hasChanges =
        state.configFormMode === "raw"
          ? state.configRaw !== state.configRawOriginal
          : Boolean(state.configFormDirty);
      if (!hasChanges) return false;

      if (state.configFormMode === "form") {
        if (!state.configForm) return false;
        const analysis = analyzeConfigSchema(state.configSchema);
        if (analysis.schema && analysis.unsupportedPaths.length > 0) return false;
      }

      return true;
    },
    getIsDirty: () => {
      const hasChanges =
        state.configFormMode === "raw"
          ? state.configRaw !== state.configRawOriginal
          : Boolean(state.configFormDirty);
      return hasChanges;
    },
    onFocusSearch: () => {
      const input = document.getElementById("config-search-input") as HTMLInputElement | null;
      input?.focus();
    },
    onClearSearch: () => {
      state.configSearchQuery = "";
    },
    onSave: () => {
      void saveConfig(state);
    },
  });
}

function cleanupConfigKeyboardShortcuts(host: SettingsHost) {
  if (host.configKeyboardCleanup) {
    host.configKeyboardCleanup();
    host.configKeyboardCleanup = null;
  }
}

function setupOverseerKeyboardShortcutsForHost(host: SettingsHost) {
  cleanupOverseerKeyboardShortcuts(host);

  const state = host as unknown as ClawdbotApp;
  host.overseerKeyboardCleanup = setupOverseerKeyboardShortcuts({
    getDrawerOpen: () => state.overseerDrawerOpen,
    onCloseDrawer: () => state.handleOverseerDrawerClose(),
  });
}

function cleanupOverseerKeyboardShortcuts(host: SettingsHost) {
  if (host.overseerKeyboardCleanup) {
    host.overseerKeyboardCleanup();
    host.overseerKeyboardCleanup = null;
  }
}
