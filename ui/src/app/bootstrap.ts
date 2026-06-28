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
  type AppRouteModule,
  type ApplicationRouter,
  type RouteId,
} from "../app-routes.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createSessionCapability, resolveSessionKey } from "../lib/sessions/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import type { RouteLocation } from "../router/types.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { createBrowserHistory } from "./browser.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayConnection,
  ApplicationNavigationOptions,
  ApplicationGatewaySnapshot,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationTheme,
} from "./context.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { createApplicationOverlays } from "./overlays.ts";
import {
  loadLocalUserIdentity,
  loadSettings,
  resolveApplicationStartupSettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";

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
        applyStartupPresentation(settings);
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
      const nextSettings = { ...settings, themeMode: mode };
      const currentTheme = resolveTheme(settings.theme, settings.themeMode);
      const nextTheme = resolveTheme(nextSettings.theme, nextSettings.themeMode);
      startThemeTransition({
        nextTheme,
        currentTheme,
        context: { element },
        applyTheme: () => {
          settings = nextSettings;
          saveSettings(settings);
          applyStartupPresentation(settings);
          syncSystemThemeListener();
        },
      });
    },
    dispose: detachSystemThemeListener,
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
      settings = {
        ...settings,
        navCollapsed: nextSnapshot.navCollapsed,
        navGroupsCollapsed: nextSnapshot.navGroupsCollapsed,
        recentSessionsCollapsed: nextSnapshot.recentSessionsCollapsed,
      };
      snapshot = nextSnapshot;
      saveSettings(settings);
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

  const connect = (overrides: Partial<ApplicationGatewayConnection> = {}) => {
    const nextConnection = { ...connection, ...overrides };
    connection = nextConnection;
    settings = {
      ...settings,
      gatewayUrl: nextConnection.gatewayUrl,
      token: nextConnection.token,
    };
    saveSettings(settings);
    client?.stop();
    stopClientEvents?.();
    stopClientEvents = undefined;

    let nextClient!: GatewayBrowserClient;
    nextClient = new GatewayBrowserClient({
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
        const sessionDefaults = readSessionDefaults(hello);
        const sessionKey = resolveSessionKey(snapshot.sessionKey, hello);
        const lastActiveSessionKey = resolveSessionKey(settings.lastActiveSessionKey, hello);
        if (
          sessionKey !== settings.sessionKey ||
          lastActiveSessionKey !== settings.lastActiveSessionKey
        ) {
          settings = {
            ...settings,
            sessionKey,
            lastActiveSessionKey,
          };
          saveSettings(settings);
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
    });
    client = nextClient;
    syncClientEvents(nextClient);
    setSnapshot({
      ...snapshot,
      client: nextClient,
      connected: false,
      hello: null,
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
    connect,
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
    subscribeEvents: (listener) => {
      eventListeners.add(listener);
      if (client) {
        const remove = client.addEventListener(listener);
        return () => {
          eventListeners.delete(listener);
          remove();
        };
      }
      return () => {
        eventListeners.delete(listener);
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
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(gateway);
  const config = createApplicationConfigCapability({
    basePath,
    auth: {
      settings: { token: settings.token },
      password: startup.password ?? "",
    },
  });
  const sessions = createSessionCapability(gateway);
  const overlays = createApplicationOverlays(gateway);
  const navigation = createApplicationNavigationPreferences(settings);
  const theme = createApplicationTheme(settings);
  applyStartupPresentation(settings);
  const identity = loadLocalUserIdentity();
  const router = createApplicationRouter();
  let pendingGatewayConnection =
    startup.pendingGatewayUrl !== null
      ? {
          gatewayUrl: startup.pendingGatewayUrl,
          token: startup.pendingGatewayToken ?? "",
        }
      : null;
  let context!: ApplicationContext<RouteId>;
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
  const navigate = (routeId: RouteId, options?: ApplicationNavigationOptions) => {
    void router
      .navigate(routeId, context, { history: "push" }, routeLocation(routeId, options))
      .catch((error) => {
        console.error("[openclaw] route navigation failed", error);
      });
  };
  const replace = (routeId: RouteId, options?: ApplicationNavigationOptions) => {
    void router
      .navigate(routeId, context, { history: "replace" }, routeLocation(routeId, options))
      .catch((error) => {
        console.error("[openclaw] route replacement failed", error);
      });
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
  context = {
    basePath,
    assistantName: identity.name || "OpenClaw",
    gateway,
    agentIdentity,
    agentSelection,
    config,
    sessions,
    overlays,
    navigation,
    theme,
    navigate,
    replace,
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
      sessions.dispose();
      overlays.dispose();
      theme.dispose();
    },
  };
}
