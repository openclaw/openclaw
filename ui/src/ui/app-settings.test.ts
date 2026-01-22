import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "./navigation";

type SettingsHost = Parameters<typeof import("./app-settings").setTabFromRoute>[0];

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
});

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts and stops log polling based on the tab", async () => {
    const startLogsPolling = vi.fn();
    const stopLogsPolling = vi.fn();
    const startDebugPolling = vi.fn();
    const stopDebugPolling = vi.fn();

    vi.doMock("./app-polling", () => ({
      startLogsPolling,
      stopLogsPolling,
      startDebugPolling,
      stopDebugPolling,
    }));

    const { setTabFromRoute } = await import("./app-settings");
    const host = createHost("chat");

    setTabFromRoute(host, "logs");
    expect(startLogsPolling).toHaveBeenCalledTimes(1);
    expect(stopLogsPolling).not.toHaveBeenCalled();
    expect(startDebugPolling).not.toHaveBeenCalled();
    expect(stopDebugPolling).toHaveBeenCalledTimes(1);

    setTabFromRoute(host, "chat");
    expect(stopLogsPolling).toHaveBeenCalledTimes(1);
  });

  it("starts and stops debug polling based on the tab", async () => {
    const startLogsPolling = vi.fn();
    const stopLogsPolling = vi.fn();
    const startDebugPolling = vi.fn();
    const stopDebugPolling = vi.fn();

    vi.doMock("./app-polling", () => ({
      startLogsPolling,
      stopLogsPolling,
      startDebugPolling,
      stopDebugPolling,
    }));

    const { setTabFromRoute } = await import("./app-settings");
    const host = createHost("chat");

    setTabFromRoute(host, "debug");
    expect(startDebugPolling).toHaveBeenCalledTimes(1);
    expect(stopDebugPolling).not.toHaveBeenCalled();
    expect(startLogsPolling).not.toHaveBeenCalled();
    expect(stopLogsPolling).toHaveBeenCalledTimes(1);

    setTabFromRoute(host, "chat");
    expect(stopDebugPolling).toHaveBeenCalledTimes(1);
  });
});
