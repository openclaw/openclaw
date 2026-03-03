import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySettingsFromUrl, setTabFromRoute } from "./app-settings.ts";
import type { Tab } from "./navigation.ts";

type SettingsHost = Parameters<typeof setTabFromRoute>[0] & {
  logsPollInterval: number | null;
  debugPollInterval: number | null;
};

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
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
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
});

describe("applySettingsFromUrl", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
  });

  it("auto-applies loopback gatewayUrl without confirmation", () => {
    const host = createHost("chat");
    host.settings.gatewayUrl = `ws://${window.location.host}`;
    window.history.replaceState({}, "", "/?gatewayUrl=ws://127.0.0.1:18789&token=dev-token");

    applySettingsFromUrl(host);

    expect(host.settings.gatewayUrl).toBe("ws://127.0.0.1:18789");
    expect(host.settings.token).toBe("dev-token");
    expect(host.pendingGatewayUrl).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("requires confirmation for non-loopback gatewayUrl", () => {
    const host = createHost("chat");
    host.settings.gatewayUrl = `ws://${window.location.host}`;
    window.history.replaceState({}, "", "/?gatewayUrl=ws://192.168.31.10:18789");

    applySettingsFromUrl(host);

    expect(host.settings.gatewayUrl).toBe(`ws://${window.location.host}`);
    expect(host.pendingGatewayUrl).toBe("ws://192.168.31.10:18789");
  });
});
