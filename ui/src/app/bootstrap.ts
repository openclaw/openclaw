import type { RouteLocation } from "@openclaw/uirouter";
import type { EventLogEntry } from "../api/event-log.ts";
import {
  GatewayBrowserClient,
  type GatewayEventListener,
  type GatewayHelloOk,
} from "../api/gateway.ts";
import {
  createApplicationRouter,
  inferBasePathFromPathname,
  locationForRoute,
  normalizeBasePath,
  pathForRoute,
  routeIdFromPath,
  startApplicationRouter,
  type ApplicationRouter,
  type RouteId,
} from "../app-routes.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/index.ts";
import { createSessionCapability, resolveSessionKey } from "../lib/sessions/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import { createWorkboardCapability } from "../lib/workboard/capability.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { createBrowserHistory } from "./browser.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayConnectOptions,
  ApplicationGatewayConnection,
  ApplicationNavigationOptions,
  ApplicationGatewaySnapshot,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationSkillWorkshopRevisionHandoff,
  ApplicationTheme,
} from "./context.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";
import { createApplicationOverlays } from "./overlays.ts";
import {
  loadSettings,
  patchSettings,
  resolveApplicationStartupSettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
import { createWebPushCapability } from "./web-push.ts";

function normalizeInitialApplicationLocation(
  location: RouteLocation,
  basePath: string,
  sessionKey: string,
) {
  const routeId = routeIdFromPath(location.pathname, basePath);
  if ((routeId !== null && routeId !== "chat") || !sessionKey.trim()) {
    return location;
  }

  const search = new URLSearchParams(location.search);
  if (!search.get("session")?.trim()) {
    search.set("session", sessionKey);
  }
  return {
    ...location,
    pathname: routeId === null ? pathForRoute("chat", basePath) : location.pathname,
    search: `?${search.toString()}`,
  };
}

function applyStartupPresentation(settings: ReturnType<typeof loadSettings>): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(settings.theme, settings.themeMode);
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark";
  root.style.colorScheme = root.dataset.themeMode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
  syncCustomThemeStyleTag(settings.customTheme);
}

function createApplicationTheme(
  initialSettings: UiSettings,
): ApplicationTheme & { dispose: () => void } {
  let settings = initialSettings;
  let systemThemeCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    applyStartupPresentation(settings);
    for (const listener of listeners) {
      listener();
    }
  };

  const detachSystemThemeListener = () => {
    systemThemeCleanup?.();
    systemThemeCleanup = undefined;
  };

  const syncSystemThemeListener = () => {
    detachSystemThemeListener();
    if (settings.themeMode !== "system" || typeof globalThis.matchMedia !== "function") {
      return;
    }
    const mediaQuery = globalThis.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (settings.themeMode === "system") {
        publish();
      }
    };
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      systemThemeCleanup = () => mediaQuery.removeEventListener("change", onChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      systemThemeCleanup = () => mediaQuery.removeListener(onChange);
    }
  };

  syncSystemThemeListener();

  return {
    get mode() {
      return settings.themeMode;
    },
    setMode(mode: ThemeMode, element) {
      const currentSettings = loadSettings();
      const nextSettings = { ...currentSettings, themeMode: mode };
      const currentTheme = resolveTheme(currentSettings.theme, currentSettings.themeMode);
      const nextTheme = resolveTheme(nextSettings.theme, nextSettings.themeMode);
      startThemeTransition({
        nextTheme,
        currentTheme,
        context: { element },
        applyTheme: () => {
          settings = patchSettings({ themeMode: mode });
          publish();
          syncSystemThemeListener();
        },
      });
    },
    refresh() {
      settings = loadSettings();
      publish();
      syncSystemThemeListener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      detachSystemThemeListener();
      listeners.clear();
    },
  };
}

function createApplicationNavigationPreferences(
  initialSettings: UiSettings,
): ApplicationNavigationPreferences {
  let settings = initialSettings;
  let snapshot: ApplicationNavigationPreferencesSnapshot = {
    navCollapsed: settings.navCollapsed,
    navGroupsCollapsed: settings.navGroupsCollapsed,
    recentSessionsCollapsed: settings.recentSessionsCollapsed ?? false,
  };
  const listeners = new Set<(next: ApplicationNavigationPreferencesSnapshot) => void>();

  return {
    get snapshot() {
      return snapshot;
    },
    update(patch) {
      const nextSnapshot = { ...snapshot, ...patch };
      if (
        nextSnapshot.navCollapsed === snapshot.navCollapsed &&
        nextSnapshot.recentSessionsCollapsed === snapshot.recentSessionsCollapsed &&
        nextSnapshot.navGroupsCollapsed === snapshot.navGroupsCollapsed
      ) {
        return;
      }
      settings = patchSettings({
        navCollapsed: nextSnapshot.navCollapsed,
        navGroupsCollapsed: nextSnapshot.navGroupsCollapsed,
        recentSessionsCollapsed: nextSnapshot.recentSessionsCollapsed,
      });
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createSkillWorkshopRevisionHandoff(): ApplicationSkillWorkshopRevisionHandoff {
  let pending: Parameters<ApplicationSkillWorkshopRevisionHandoff["prepare"]>[0] | null = null;
  return {
    prepare: (handoff) => {
      pending = handoff;
    },
    consume: (sessionKey) => {
      if (!pending || pending.sessionKey !== sessionKey) {
        return null;
      }
      const handoff = pending;
      pending = null;
      return handoff;
    },
    clear: () => {
      pending = null;
    },
  };
}

function createApplicationGateway(
  initialSettings: ReturnType<typeof loadSettings>,
  initialPassword = "",
): ApplicationGateway {
  let settings = initialSettings;
  let connection: ApplicationGatewayConnection = {
    gatewayUrl: settings.gatewayUrl,
    token: settings.token,
    password: initialPassword,
  };
  let snapshot: ApplicationGatewaySnapshot = {
    client: null,
    connected: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: settings.sessionKey,
    lastError: null,
    lastErrorCode: null,
  };
  let client: GatewayBrowserClient | null = null;
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const eventLogListeners = new Set<(events: readonly EventLogEntry[]) => void>();
  let eventLog: EventLogEntry[] = [];
  let stopClientEvents: (() => void) | undefined;
  const syncClientEvents = (nextClient: GatewayBrowserClient | null) => {
    stopClientEvents?.();
    stopClientEvents = undefined;
    if (!nextClient || eventListeners.size === 0) {
      return;
    }
    const removers = [...eventListeners].map((listener) => nextClient.addEventListener(listener));
    stopClientEvents = () => {
      for (const remove of removers) {
        remove();
      }
    };
  };
  const notify = () => {
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const setSnapshot = (next: ApplicationGatewaySnapshot) => {
    snapshot = next;
    notify();
  };
  const publishEventLog = () => {
    for (const listener of eventLogListeners) {
      listener(eventLog);
    }
  };
  const recordGatewayEvent = (event: Parameters<GatewayEventListener>[0]) => {
    eventLog = [{ ts: Date.now(), event: event.event, payload: event.payload }, ...eventLog].slice(
      0,
      250,
    );
    publishEventLog();
  };

  const connect = (overrides: ApplicationGatewayConnectOptions = {}) => {
    const { sessionKey: requestedSessionKey, ...connectionOverrides } = overrides;
    const nextConnection = { ...connection, ...connectionOverrides };
    const hasRequestedSessionKey = requestedSessionKey !== undefined;
    const nextSessionKey = hasRequestedSessionKey
      ? requestedSessionKey.trim()
      : snapshot.sessionKey;
    connection = nextConnection;
    settings = patchSettings({
      gatewayUrl: nextConnection.gatewayUrl,
      token: nextConnection.token,
      ...(hasRequestedSessionKey
        ? {
            sessionKey: nextSessionKey,
            lastActiveSessionKey: nextSessionKey,
          }
        : {}),
    });
    client?.stop();
    stopClientEvents?.();
    stopClientEvents = undefined;

    const nextClient = new GatewayBrowserClient({
      url: nextConnection.gatewayUrl,
      token: nextConnection.token.trim() ? nextConnection.token : undefined,
      password: nextConnection.password.trim() ? nextConnection.password : undefined,
      clientName: "openclaw-control-ui",
      clientVersion: "dev",
      mode: "webchat",
      instanceId: generateUUID(),
      onHello: (hello: GatewayHelloOk) => {
        if (client !== nextClient) {
          return;
        }
        settings = loadSettings();
        const sessionDefaults = readSessionDefaults(hello);
        const sessionKey = resolveSessionKey(snapshot.sessionKey, hello);
        const lastActiveSessionKey = resolveSessionKey(settings.lastActiveSessionKey, hello);
        if (
          sessionKey !== settings.sessionKey ||
          lastActiveSessionKey !== settings.lastActiveSessionKey
        ) {
          settings = patchSettings({
            sessionKey,
            lastActiveSessionKey,
          });
        }
        setSnapshot({
          ...snapshot,
          client: nextClient,
          connected: true,
          hello,
          assistantAgentId: sessionDefaults?.defaultAgentId ?? "main",
          sessionKey,
          lastError: null,
          lastErrorCode: null,
        });
      },
      onClose: ({ code, reason, error }) => {
        if (client !== nextClient) {
          return;
        }
        setSnapshot({
          ...snapshot,
          client: nextClient,
          connected: false,
          hello: null,
          lastError: error?.message ?? `disconnected (${code}): ${reason || "no reason"}`,
          lastErrorCode: error?.code ?? null,
        });
      },
      onGap: ({ expected, received }) => {
        if (client !== nextClient) {
          return;
        }
        setSnapshot({
          ...snapshot,
          lastError: `event gap detected (expected seq ${expected}, got ${received}); reconnecting`,
          lastErrorCode: null,
        });
        connect();
      },
      onEvent: recordGatewayEvent,
    });
    client = nextClient;
    syncClientEvents(nextClient);
    setSnapshot({
      ...snapshot,
      client: nextClient,
      connected: false,
      hello: null,
      sessionKey: nextSessionKey,
      lastError: null,
      lastErrorCode: null,
    });
    nextClient.start();
  };

  const gateway: ApplicationGateway = {
    get snapshot() {
      return snapshot;
    },
    get connection() {
      return connection;
    },
    get eventLog() {
      return eventLog;
    },
    connect,
    setSessionKey: (sessionKey) => {
      const nextSessionKey = sessionKey.trim();
      if (!nextSessionKey || nextSessionKey === snapshot.sessionKey) {
        return;
      }
      settings = patchSettings({
        sessionKey: nextSessionKey,
        lastActiveSessionKey: nextSessionKey,
      });
      setSnapshot({ ...snapshot, sessionKey: nextSessionKey });
    },
    start: () => connect(),
    stop: () => {
      stopClientEvents?.();
      stopClientEvents = undefined;
      client?.stop();
      client = null;
      setSnapshot({
        ...snapshot,
        client: null,
        connected: false,
        hello: null,
        lastError: null,
        lastErrorCode: null,
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: (listener) => {
      eventLogListeners.add(listener);
      return () => eventLogListeners.delete(listener);
    },
    subscribeEvents: (listener) => {
      eventListeners.add(listener);
      syncClientEvents(client);
      return () => {
        if (eventListeners.delete(listener)) {
          syncClientEvents(client);
        }
      };
    },
  };
  return gateway;
}

function readSessionDefaults(
  hello: GatewayHelloOk,
): { defaultAgentId?: string | null } | undefined {
  const snapshot = hello.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return undefined;
  }
  const defaults = snapshot.sessionDefaults;
  return defaults && typeof defaults === "object"
    ? (defaults as { defaultAgentId?: string | null })
    : undefined;
}

export type ApplicationRuntime = {
  readonly context: ApplicationContext<RouteId>;
  readonly router: ApplicationRouter;
  readonly pendingGatewayConnection: {
    readonly gatewayUrl: string;
    readonly token: string;
  } | null;
  readonly confirmPendingGatewayConnection: () => void;
  readonly cancelPendingGatewayConnection: () => void;
  start: () => Promise<void>;
  stop: () => void;
};

export function bootstrapApplication(): ApplicationRuntime {
  const initialSettings = loadSettings();
  const history = createBrowserHistory();
  const startup = resolveApplicationStartupSettings(initialSettings, history.location());
  if (startup.changed) {
    saveSettings(startup.settings);
  }
  const basePath = normalizeBasePath(
    inferBasePathFromPathname(startup.location.pathname || globalThis.location?.pathname || "/"),
  );
  const initialLocation = normalizeInitialApplicationLocation(
    startup.location,
    basePath,
    startup.settings.sessionKey,
  );
  const currentLocation = history.location();
  if (
    currentLocation.pathname !== initialLocation.pathname ||
    currentLocation.search !== initialLocation.search ||
    currentLocation.hash !== initialLocation.hash
  ) {
    history.replace(initialLocation);
  }

  const settings = startup.settings;
  const gateway = createApplicationGateway(settings, startup.password ?? "");
  const agents = createAgentCapability(gateway);
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(gateway);
  const channels = createChannelCapability(gateway);
  const config = createApplicationConfigCapability({
    basePath,
    auth: {
      settings: { token: settings.token },
      password: startup.password ?? "",
    },
  });
  const sessions = createSessionCapability(gateway);
  const workboard = createWorkboardCapability();
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const overlays = createApplicationOverlays(gateway);
  const navigation = createApplicationNavigationPreferences(settings);
  const theme = createApplicationTheme(settings);
  const nativeChatDrafts = createNativeChatDrafts();
  const webPush = createWebPushCapability(gateway);
  const skillWorkshopRevision = createSkillWorkshopRevisionHandoff();
  applyStartupPresentation(settings);
  const router = createApplicationRouter();
  let pendingGatewayConnection =
    startup.pendingGatewayUrl !== null
      ? {
          gatewayUrl: startup.pendingGatewayUrl,
          token: startup.pendingGatewayToken ?? "",
        }
      : null;
  let lastConfigRefreshClient: GatewayBrowserClient | null = null;
  const stopConfigRefresh = gateway.subscribe((snapshot) => {
    if (!snapshot.connected || !snapshot.client) {
      lastConfigRefreshClient = null;
      return;
    }
    if (lastConfigRefreshClient === snapshot.client) {
      return;
    }
    lastConfigRefreshClient = snapshot.client;
    void config.refresh({
      auth: {
        hello: snapshot.hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      },
    });
  });
  const routeLocation = (routeId: RouteId, options?: ApplicationNavigationOptions) => {
    const location = locationForRoute(routeId, basePath);
    if (options?.search !== undefined || options?.hash !== undefined) {
      return {
        ...location,
        search: options?.search ?? "",
        hash: options?.hash ?? "",
      };
    }
    return location;
  };
  const confirmPendingGatewayConnection = () => {
    const pending = pendingGatewayConnection;
    if (!pending) {
      return;
    }
    pendingGatewayConnection = null;
    gateway.connect({
      gatewayUrl: pending.gatewayUrl,
      token: pending.token,
    });
  };
  const cancelPendingGatewayConnection = () => {
    pendingGatewayConnection = null;
  };
  const context: ApplicationContext<RouteId> = {
    basePath,
    gateway,
    agents,
    agentIdentity,
    agentSelection,
    channels,
    config,
    runtimeConfig,
    sessions,
    workboard,
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    webPush,
    skillWorkshopRevision,
    navigate: (routeId, options) => {
      void router
        .navigate(routeId, context, { history: "push" }, routeLocation(routeId, options))
        .catch((error: unknown) => {
          console.error("[openclaw] route navigation failed", error);
        });
    },
    replace: (routeId, options) => {
      void router
        .navigate(routeId, context, { history: "replace" }, routeLocation(routeId, options))
        .catch((error: unknown) => {
          console.error("[openclaw] route replacement failed", error);
        });
    },
    preload: (routeId) => router.preloadRoute(routeId, context),
  };
  return {
    context,
    router,
    get pendingGatewayConnection() {
      return pendingGatewayConnection;
    },
    confirmPendingGatewayConnection,
    cancelPendingGatewayConnection,
    start: async () => {
      void config.refresh({ skipWithoutAuthCandidate: true });
      const routerStart = startApplicationRouter(router, history, basePath, context);
      gateway.start();
      await routerStart;
    },
    stop: () => {
      stopConfigRefresh();
      router.stop();
      gateway.stop();
      agents.dispose();
      channels.dispose();
      sessions.dispose();
      workboard.dispose();
      runtimeConfig.dispose();
      overlays.dispose();
      theme.dispose();
      nativeChatDrafts.dispose();
      webPush.dispose();
      skillWorkshopRevision.clear();
    },
  };
}
