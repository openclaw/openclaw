import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyResolvedTheme,
  applySettings,
  attachThemeListener,
  setTabFromRoute,
  syncThemeWithSettings,
} from "./app-settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

type Tab =
  | "agents"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "infrastructure"
  | "aiAgents"
  | "debug"
  | "logs";

type SettingsHost = {
  settings: {
    gatewayUrl: string;
    token: string;
    sessionKey: string;
    lastActiveSessionKey: string;
    theme: ThemeName;
    themeMode: ThemeMode;
    chatFocusMode: boolean;
    chatShowThinking: boolean;
    chatShowToolCalls: boolean;
    splitRatio: number;
    navCollapsed: boolean;
    navWidth: number;
    navGroupsCollapsed: Record<string, boolean>;
  };
  theme: ThemeName & ThemeMode;
  themeMode: ThemeMode;
  themeResolved: import("./theme.ts").ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
};

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
  },
  theme: "claw" as unknown as ThemeName & ThemeMode,
  themeMode: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(host.debugPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.debugPollInterval).toBeNull();
  });

  it("re-resolves the active palette when only themeMode changes", () => {
    const host = createHost("chat");
    host.settings.theme = "knot";
    host.settings.themeMode = "dark";
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "dark";
    host.themeResolved = "openknot";

    applySettings(host, {
      ...host.settings,
      themeMode: "light",
    });

    expect(host.theme).toBe("knot");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("openknot-light");
  });

  it("syncs both theme family and mode from persisted settings", () => {
    const host = createHost("chat");
    host.settings.theme = "dash";
    host.settings.themeMode = "light";

    syncThemeWithSettings(host);

    expect(host.theme).toBe("dash");
    expect(host.themeMode).toBe("light");
    expect(host.themeResolved).toBe("dash-light");
  });

  it("applies named system themes on OS preference changes", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_name: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners.push(handler);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const host = createHost("chat");
    host.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.themeMode = "system";

    attachThemeListener(host);
    listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");

    listeners[0]?.({ matches: false } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("openknot");
  });

  it("normalizes light family themes to the shared light CSS token", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration & { colorScheme: string },
    };
    vi.stubGlobal("document", { documentElement: root } as Document);

    const host = createHost("chat");
    applyResolvedTheme(host, "dash-light");

    expect(host.themeResolved).toBe("dash-light");
    expect(root.dataset.theme).toBe("dash-light");
    expect(root.style.colorScheme).toBe("light");
  });
});
