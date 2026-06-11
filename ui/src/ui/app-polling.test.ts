// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadKalshiDashboardMock, loadNodesMock } = vi.hoisted(() => ({
  loadKalshiDashboardMock: vi.fn(),
  loadNodesMock: vi.fn(),
}));

vi.mock("./controllers/debug.ts", () => ({
  loadDebug: vi.fn(),
}));

vi.mock("./controllers/kalshi-dashboard.ts", () => ({
  loadKalshiDashboard: loadKalshiDashboardMock,
}));

vi.mock("./controllers/logs.ts", () => ({
  loadLogs: vi.fn(),
}));

vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: loadNodesMock,
}));

import { startKalshiDashboardPolling, startNodesPolling } from "./app-polling.ts";

function createHost() {
  return {
    nodesPollInterval: null,
    logsPollInterval: null,
    debugPollInterval: null,
    kalshiDashboardPollInterval: null as number | null,
    tab: "agents",
    agentsPanel: "room",
    connected: true,
  } as {
    agentsPanel: string;
    connected: boolean;
    debugPollInterval: null;
    kalshiDashboardAuditPages?: Record<string, number>;
    kalshiDashboardAuditQueries?: Record<string, string>;
    kalshiDashboardPollInterval: number | null;
    kalshiDashboardShowDeepAudit?: boolean;
    logsPollInterval: null;
    nodesPollInterval: null;
    tab: string;
  };
}

describe("startKalshiDashboardPolling", () => {
  beforeEach(() => {
    loadKalshiDashboardMock.mockReset();
    vi.stubGlobal("window", {
      setInterval: vi.fn(() => 42),
    });
  });

  it("requests a Kalshi snapshot immediately when polling starts", () => {
    const host = createHost();

    startKalshiDashboardPolling(host);

    expect(loadKalshiDashboardMock).toHaveBeenCalledTimes(1);
    expect(loadKalshiDashboardMock).toHaveBeenCalledWith(host, { quiet: true, view: "workspace" });
    expect(host.kalshiDashboardPollInterval).toBe(42);
  });

  it("refreshes immediately even when the polling timer already exists", () => {
    const host = createHost();
    host.kalshiDashboardPollInterval = 7;

    startKalshiDashboardPolling(host);

    expect(loadKalshiDashboardMock).toHaveBeenCalledTimes(1);
    expect(loadKalshiDashboardMock).toHaveBeenCalledWith(host, { quiet: true, view: "workspace" });
    expect(host.kalshiDashboardPollInterval).toBe(7);
  });

  it("keeps the Kalshi page fast with the compact snapshot by default", () => {
    const host = createHost();
    host.tab = "kalshi";

    startKalshiDashboardPolling(host);

    expect(loadKalshiDashboardMock).toHaveBeenCalledWith(host, { quiet: true, view: "workspace" });
  });

  it("carries audit paging options when the full Kalshi snapshot is requested", () => {
    const host = createHost();
    host.tab = "kalshi";
    host.kalshiDashboardShowDeepAudit = true;
    host.kalshiDashboardAuditPages = { pending: 2 };
    host.kalshiDashboardAuditQueries = { pending: "weather" };

    startKalshiDashboardPolling(host);

    expect(loadKalshiDashboardMock).toHaveBeenCalledWith(host, {
      auditTablePages: { pending: 2 },
      auditTableQueries: { pending: "weather" },
      quiet: true,
      view: "full",
    });
  });
});

describe("startNodesPolling", () => {
  beforeEach(() => {
    loadNodesMock.mockReset();
  });

  it("does not poll nodes while another dashboard tab is active", () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("window", {
      setInterval: vi.fn((callback: () => void) => {
        callbacks.push(callback);
        return 42;
      }),
    });
    const host = createHost();
    host.tab = "agents";

    startNodesPolling(host);
    callbacks[0]?.();

    expect(loadNodesMock).not.toHaveBeenCalled();
    expect(host.nodesPollInterval).toBe(42);
  });

  it("polls nodes only while the Nodes tab is active", () => {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("window", {
      setInterval: vi.fn((callback: () => void) => {
        callbacks.push(callback);
        return 42;
      }),
    });
    const host = createHost();
    host.tab = "nodes";

    startNodesPolling(host);
    callbacks[0]?.();

    expect(loadNodesMock).toHaveBeenCalledTimes(1);
    expect(loadNodesMock).toHaveBeenCalledWith(host, { quiet: true });
  });
});
