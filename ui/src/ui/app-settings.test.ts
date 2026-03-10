import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTabFromRoute } from "./app-settings.ts";
import type { Tab } from "./navigation.ts";

type SettingsHost = Parameters<typeof setTabFromRoute>[0] & {
  chatPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  chatLoading: boolean;
  chatSending: boolean;
  chatRunId: string | null;
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
  chatLoading: false,
  chatSending: false,
  chatRunId: null,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  chatPollInterval: null,
  logsPollInterval: null,
  debugPollInterval: null,
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
    expect(host.chatPollInterval).toBeNull();
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "chat");
    expect(host.chatPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops chat polling based on the tab", () => {
    const host = createHost("logs");

    setTabFromRoute(host, "chat");
    expect(host.chatPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(host, "debug");
    expect(host.chatPollInterval).toBeNull();
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
