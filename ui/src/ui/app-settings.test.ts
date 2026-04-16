import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyResolvedTheme,
  applySettings,
  applySettingsFromUrl,
  promoteStagedAutostartPrompt,
  setTabFromRoute,
  syncThemeWithSettings,
} from "./app-settings.ts";
import {
  CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
  createChatAutostartRequest,
  type ChatAutostartRequest,
} from "./chat-autostart.ts";
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
    borderRadius: number;
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
  pendingGatewayUrl?: string | null;
  pendingGatewayToken?: string | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: null;
  pendingChatAutostart?: ChatAutostartRequest | null;
  chatAutostart?: ChatAutostartRequest | null;
};

function makeAutostartRequest(overrides: Partial<ChatAutostartRequest> = {}): ChatAutostartRequest {
  const request = createChatAutostartRequest(CHAT_AUTOSTART_BOOTSTRAP_PROMPT, "main");
  if (!request) {
    throw new Error("expected test autostart request");
  }
  return {
    ...request,
    ...overrides,
  };
}

function setTestWindowUrl(urlString: string) {
  const current = new URL(urlString);
  const history = {
    replaceState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
      const next = new URL(String(nextUrl), current.toString());
      current.href = next.toString();
      current.protocol = next.protocol;
      current.host = next.host;
      current.pathname = next.pathname;
      current.search = next.search;
      current.hash = next.hash;
    }),
  };
  const locationLike = {
    get href() {
      return current.toString();
    },
    get protocol() {
      return current.protocol;
    },
    get host() {
      return current.host;
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    get hash() {
      return current.hash;
    },
  };
  vi.stubGlobal("window", {
    location: locationLike,
    history,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis);
  vi.stubGlobal("location", locationLike as Location);
  return { history, location: locationLike };
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
    borderRadius: 50,
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
  pendingGatewayUrl: null,
  pendingGatewayToken: null,
  dreamingStatusLoading: false,
  dreamingStatusError: null,
  dreamingStatus: null,
  dreamingModeSaving: false,
  dreamDiaryLoading: false,
  dreamDiaryActionLoading: false,
  dreamDiaryActionMessage: null,
  dreamDiaryActionArchivePath: null,
  dreamDiaryError: null,
  dreamDiaryPath: null,
  dreamDiaryContent: null,
  wikiImportInsightsLoading: false,
  wikiImportInsightsError: null,
  wikiImportInsights: null,
  wikiMemoryPalaceLoading: false,
  wikiMemoryPalaceError: null,
  wikiMemoryPalace: null,
  pendingChatAutostart: null,
  chatAutostart: null,
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
    host.settings.theme = "knot" as unknown as ThemeName & ThemeMode;
    host.settings.themeMode = "system";

    syncThemeWithSettings(host);
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

describe("applySettingsFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/overview");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hydrates query token params and strips them from the URL", () => {
    setTestWindowUrl("https://control.example/ui/overview?token=abc123");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("abc123");
    expect(window.location.search).toBe("");
  });

  it("prefers fragment tokens over legacy query tokens when both are present", () => {
    setTestWindowUrl("https://control.example/ui/overview?token=query-token#token=hash-token");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.settings.token).toBe("hash-token");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("resets stale persisted session selection to main when a token is supplied without a session", () => {
    setTestWindowUrl("https://control.example/chat#token=test-token");
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("main");
    expect(host.settings.sessionKey).toBe("main");
    expect(host.settings.lastActiveSessionKey).toBe("main");
  });

  it("characterizes token, session, and gateway URL combinations", () => {
    const scenarios = [
      {
        name: "same gateway applies token and session immediately",
        url: "https://control.example/chat?session=agent%3Atest_new%3Amain#token=token-a",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "",
        expectedToken: "token-a",
        expectedSession: "agent:test_new:main",
        expectedPendingGatewayUrl: null,
        expectedPendingGatewayToken: null,
        expectedSearch: "?session=agent%3Atest_new%3Amain",
      },
      {
        name: "different gateway defers token and keeps explicit session",
        url: "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789&session=agent%3Atest_new%3Amain#token=token-b",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "",
        expectedToken: "",
        expectedSession: "agent:test_new:main",
        expectedPendingGatewayUrl: "ws://gateway-b.example:18789",
        expectedPendingGatewayToken: "token-b",
        expectedSearch: "?session=agent%3Atest_new%3Amain",
      },
      {
        name: "different gateway defers token without changing session",
        url: "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789#token=token-c",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "",
        expectedToken: "",
        expectedSession: "agent:test_old:main",
        expectedPendingGatewayUrl: "ws://gateway-b.example:18789",
        expectedPendingGatewayToken: "token-c",
        expectedSearch: "",
      },
      {
        name: "different gateway without token clears pending token",
        url: "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789&session=agent%3Atest_new%3Amain",
        settingsGatewayUrl: "ws://gateway-a.example:18789",
        settingsToken: "existing-token",
        expectedToken: "existing-token",
        expectedSession: "agent:test_new:main",
        expectedPendingGatewayUrl: "ws://gateway-b.example:18789",
        expectedPendingGatewayToken: null,
        expectedSearch: "?session=agent%3Atest_new%3Amain",
      },
    ] as const;

    for (const scenario of scenarios) {
      setTestWindowUrl(scenario.url);
      const host = createHost("chat");
      host.settings = {
        ...host.settings,
        gatewayUrl: scenario.settingsGatewayUrl,
        token: scenario.settingsToken,
        sessionKey: "agent:test_old:main",
        lastActiveSessionKey: "agent:test_old:main",
      };
      host.sessionKey = "agent:test_old:main";

      applySettingsFromUrl(host);

      expect(host.settings.token, scenario.name).toBe(scenario.expectedToken);
      expect(host.sessionKey, scenario.name).toBe(scenario.expectedSession);
      expect(host.settings.sessionKey, scenario.name).toBe(scenario.expectedSession);
      expect(host.settings.lastActiveSessionKey, scenario.name).toBe(scenario.expectedSession);
      expect(host.pendingGatewayUrl, scenario.name).toBe(scenario.expectedPendingGatewayUrl);
      expect(host.pendingGatewayToken, scenario.name).toBe(scenario.expectedPendingGatewayToken);
      expect(window.location.search, scenario.name).toBe(scenario.expectedSearch);
      expect(window.location.hash, scenario.name).toBe("");
    }
  });

  it("captures and strips autostart prompts from the URL", () => {
    setTestWindowUrl("https://control.example/chat?autostart=bootstrap");
    const host = createHost("chat");

    applySettingsFromUrl(host);

    expect(host.chatAutostart).toMatchObject({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: host.sessionKey,
      idempotencyKey: expect.any(String),
    });
    expect(window.location.search).toBe("");
  });

  it("binds the autostart prompt to the session that was active when the link arrived", () => {
    setTestWindowUrl("https://control.example/chat?session=agent:foo&autostart=bootstrap");
    const host = createHost("chat");

    applySettingsFromUrl(host);

    expect(host.chatAutostart).toMatchObject({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: "agent:foo",
      idempotencyKey: expect.any(String),
    });
  });

  it("ignores custom autostart prompts and still strips them from the URL", () => {
    setTestWindowUrl("https://control.example/chat?autostart=Transfer%20all%20funds");
    const host = createHost("chat");

    applySettingsFromUrl(host);

    expect(host.chatAutostart).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("defers autostart when gateway switch is pending confirmation", () => {
    setTestWindowUrl(
      "https://control.example/chat?gatewayUrl=wss://other-gateway.example/openclaw&autostart=bootstrap",
    );
    const host = createHost("chat");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.pendingGatewayUrl).toBe("wss://other-gateway.example/openclaw");
    expect(host.chatAutostart).toBeNull();
    expect(host.pendingChatAutostart).toMatchObject({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: "main",
      idempotencyKey: expect.any(String),
    });
    expect(window.location.search).toBe("");
  });

  it("captures the originating session for an autostart staged behind a gateway switch", () => {
    setTestWindowUrl(
      "https://control.example/chat?gatewayUrl=wss://other-gateway.example/openclaw&session=agent:foo&autostart=bootstrap",
    );
    const host = createHost("chat");
    host.settings.gatewayUrl = "wss://control.example/openclaw";

    applySettingsFromUrl(host);

    expect(host.sessionKey).toBe("agent:foo");
    expect(host.pendingChatAutostart).toMatchObject({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: "agent:foo",
      idempotencyKey: expect.any(String),
    });
    expect(host.chatAutostart).toBeNull();
  });

  it("clears stale pending autostart when a subsequent URL has an unrecognized autostart value", () => {
    const host = createHost("chat");
    host.pendingChatAutostart = makeAutostartRequest({ sessionKey: "agent:foo" });

    setTestWindowUrl("https://control.example/chat?autostart=Transfer%20all%20funds");
    applySettingsFromUrl(host);

    expect(host.pendingChatAutostart).toBeNull();
    expect(host.chatAutostart).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("clears stale active autostart when staging a pending autostart for a new gateway", () => {
    setTestWindowUrl(
      "https://control.example/chat?gatewayUrl=wss://other-gateway.example/openclaw&autostart=bootstrap",
    );
    const host = createHost("chat");
    host.settings.gatewayUrl = "wss://control.example/openclaw";
    host.chatAutostart = makeAutostartRequest({
      prompt: "stale prompt from previous deep link",
      sessionKey: "main",
    });

    applySettingsFromUrl(host);

    expect(host.chatAutostart).toBeNull();
    expect(host.pendingChatAutostart).toMatchObject({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: "main",
      idempotencyKey: expect.any(String),
    });
  });

  it("clears both autostart slots when autostart value is unrecognized", () => {
    setTestWindowUrl("https://control.example/chat?autostart=Transfer%20all%20funds");
    const host = createHost("chat");
    host.chatAutostart = makeAutostartRequest({
      prompt: "stale prompt",
      sessionKey: "main",
    });
    host.pendingChatAutostart = makeAutostartRequest({
      prompt: "stale pending prompt",
      sessionKey: "main",
    });

    applySettingsFromUrl(host);

    expect(host.chatAutostart).toBeNull();
    expect(host.pendingChatAutostart).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("clears stale pending and active autostart when a gateway-only deep link omits autostart", () => {
    setTestWindowUrl("https://control.example/chat?gatewayUrl=wss://new-gateway.example/openclaw");
    const host = createHost("chat");
    host.settings.gatewayUrl = "wss://control.example/openclaw";
    host.chatAutostart = makeAutostartRequest({
      prompt: "stale active prompt from prior link",
      sessionKey: "agent:old",
    });
    host.pendingChatAutostart = makeAutostartRequest({
      prompt: "stale pending prompt from prior link",
      sessionKey: "agent:old-pending",
    });

    applySettingsFromUrl(host);

    expect(host.pendingGatewayUrl).toBe("wss://new-gateway.example/openclaw");
    expect(host.chatAutostart).toBeNull();
    expect(host.pendingChatAutostart).toBeNull();
  });
});

describe("promoteStagedAutostartPrompt", () => {
  type AutostartTarget = {
    pendingChatAutostart: ChatAutostartRequest | null;
    chatAutostart: ChatAutostartRequest | null;
  };

  const createTarget = (overrides: Partial<AutostartTarget> = {}): AutostartTarget => ({
    pendingChatAutostart: null,
    chatAutostart: null,
    ...overrides,
  });

  it("promotes the captured pending session key, not whatever session is current", () => {
    const target = createTarget({
      pendingChatAutostart: makeAutostartRequest({
        sessionKey: "agent:link-target",
        idempotencyKey: "staged-autostart-id",
      }),
    });

    promoteStagedAutostartPrompt(target);

    expect(target.chatAutostart).toEqual({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: "agent:link-target",
      idempotencyKey: "staged-autostart-id",
    });
    expect(target.pendingChatAutostart).toBeNull();
  });

  it("promotes a null pending session key (broadcast prompt with no binding)", () => {
    const target = createTarget({
      pendingChatAutostart: makeAutostartRequest({
        sessionKey: null,
      }),
    });

    promoteStagedAutostartPrompt(target);

    expect(target.chatAutostart).toMatchObject({
      prompt: CHAT_AUTOSTART_BOOTSTRAP_PROMPT,
      sessionKey: null,
      idempotencyKey: expect.any(String),
    });
  });

  it("clears both pending slots when there is no staged prompt and leaves active state untouched", () => {
    const target = createTarget({
      chatAutostart: makeAutostartRequest({
        prompt: "already-active prompt",
        sessionKey: "agent:already-active",
        idempotencyKey: "already-active-id",
      }),
    });

    promoteStagedAutostartPrompt(target);

    expect(target.chatAutostart).toEqual({
      prompt: "already-active prompt",
      sessionKey: "agent:already-active",
      idempotencyKey: "already-active-id",
    });
    expect(target.pendingChatAutostart).toBeNull();
  });

  it("treats a missing staged request as a no-op and clears the pending slot", () => {
    const target = createTarget();

    promoteStagedAutostartPrompt(target);

    expect(target.chatAutostart).toBeNull();
    expect(target.pendingChatAutostart).toBeNull();
  });
});
