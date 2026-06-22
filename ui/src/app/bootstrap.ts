import { GatewayBrowserClient, type GatewayHelloOk } from "../api/gateway.ts";
import {
  createApplicationRouter,
  createApplicationContext,
  inferBasePathFromPathname,
  normalizeBasePath,
  startApplicationRouter,
  type ApplicationContext,
} from "../app-routes.ts";
import { generateUUID } from "../lib/uuid.ts";
import { createBrowserHistory } from "./browser.ts";
import type {
  ApplicationGateway,
  ApplicationGatewayConnection,
  ApplicationGatewaySnapshot,
  ApplicationTheme,
} from "./context.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { loadLocalUserIdentity, loadSettings, saveSettings, type UiSettings } from "./settings.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";

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

function createApplicationGateway(
  initialSettings: ReturnType<typeof loadSettings>,
): ApplicationGateway {
  let settings = initialSettings;
  let connection: ApplicationGatewayConnection = {
    gatewayUrl: settings.gatewayUrl,
    token: settings.token,
    password: "",
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
        setSnapshot({
          ...snapshot,
          client: nextClient,
          connected: true,
          hello,
          assistantAgentId: sessionDefaults?.defaultAgentId ?? "main",
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
    });
    client = nextClient;
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
  readonly context: ApplicationContext;
  start: () => Promise<void>;
  stop: () => void;
};

export function bootstrapApplication(): ApplicationRuntime {
  const settings = loadSettings();
  const gateway = createApplicationGateway(settings);
  const theme = createApplicationTheme(settings);
  applyStartupPresentation(settings);
  const basePath = normalizeBasePath(
    inferBasePathFromPathname(globalThis.location?.pathname ?? "/"),
  );
  const history = createBrowserHistory();
  const identity = loadLocalUserIdentity();
  const router = createApplicationRouter();
  const context = createApplicationContext(
    router,
    gateway,
    theme,
    basePath,
    identity.name || "OpenClaw",
  );
  return {
    context,
    start: async () => {
      gateway.start();
      await startApplicationRouter(router, history, basePath, context);
    },
    stop: () => {
      context.dispose();
      theme.dispose();
    },
  };
}
