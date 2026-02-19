import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SettingsHost = {
  settings: {
    gatewayUrl: string;
    token: string;
    sessionKey: string;
    lastActiveSessionKey: string;
    theme: "light" | "dark" | "system";
    chatFocusMode: boolean;
    chatShowThinking: boolean;
    splitRatio: number;
    navCollapsed: boolean;
    navGroupsCollapsed: Record<string, boolean>;
  };
  theme: "light" | "dark" | "system";
  themeResolved: "light" | "dark";
  applySessionKey: string;
  sessionKey: string;
  tab: "overview";
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: null;
  themeMediaHandler: null;
  pendingGatewayUrl: string | null;
};

type WindowLike = {
  location: URL;
  history: {
    replaceState: (state: unknown, title: string, url: string) => void;
  };
};

function createWindowLike(href: string): WindowLike {
  const state: WindowLike = {
    location: new URL(href),
    history: {
      replaceState: (_state, _title, url) => {
        state.location = new URL(url, state.location.href);
      },
    },
  };
  return state;
}

function createHost(): SettingsHost {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    theme: "system",
    themeResolved: "dark",
    applySessionKey: "main",
    sessionKey: "main",
    tab: "overview",
    connected: false,
    chatHasAutoScrolled: false,
    logsAtBottom: false,
    eventLog: [],
    eventLogBuffer: [],
    basePath: "/ui",
    themeMedia: null,
    themeMediaHandler: null,
    pendingGatewayUrl: null,
  };
}

function createLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

async function loadApplySettingsFromUrl() {
  const mod = await import("./app-settings.ts");
  return mod.applySettingsFromUrl;
}

describe("applySettingsFromUrl gatewayUrl override", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createLocalStorage());
    vi.stubGlobal("window", createWindowLike("http://localhost/ui/overview"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts same-host wss overrides", async () => {
    vi.stubGlobal(
      "window",
      createWindowLike(
        `http://localhost/ui/overview?gatewayUrl=${encodeURIComponent("wss://localhost:18789/ws")}`,
      ),
    );
    const host = createHost();
    const applySettingsFromUrl = await loadApplySettingsFromUrl();

    applySettingsFromUrl(host);

    expect(host.pendingGatewayUrl).toBe("wss://localhost:18789/ws");
    expect((window as unknown as WindowLike).location.search).toBe("");
  });

  it("accepts loopback ws overrides", async () => {
    vi.stubGlobal(
      "window",
      createWindowLike(
        `http://localhost/ui/overview?gatewayUrl=${encodeURIComponent("ws://127.0.0.1:18789/ws")}`,
      ),
    );
    const host = createHost();
    const applySettingsFromUrl = await loadApplySettingsFromUrl();

    applySettingsFromUrl(host);

    expect(host.pendingGatewayUrl).toBe("ws://127.0.0.1:18789/ws");
    expect((window as unknown as WindowLike).location.search).toBe("");
  });

  it("rejects cross-host overrides", async () => {
    vi.stubGlobal(
      "window",
      createWindowLike(
        `http://localhost/ui/overview?gatewayUrl=${encodeURIComponent("wss://attacker.example/ws")}`,
      ),
    );
    const host = createHost();
    const applySettingsFromUrl = await loadApplySettingsFromUrl();

    applySettingsFromUrl(host);

    expect(host.pendingGatewayUrl).toBeNull();
    expect((window as unknown as WindowLike).location.search).toBe("");
  });
});
