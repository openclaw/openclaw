// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const loadNodesMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./controllers/debug.ts", () => ({
  loadDebug: vi.fn(async () => undefined),
}));
vi.mock("./controllers/logs.ts", () => ({
  loadLogs: vi.fn(async () => undefined),
}));
vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: loadNodesMock,
}));

const { NODES_ACTIVE_POLL_INTERVAL_MS, startNodesPolling, stopNodesPolling } =
  await import("./app-polling.ts");

function createHost() {
  return {
    client: {},
    connected: true,
    nodesPollInterval: null,
    logsPollInterval: null,
    debugPollInterval: null,
    tab: "overview",
  };
}

describe("startNodesPolling", () => {
  afterEach(() => {
    stopNodesPolling(createHost() as never);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    loadNodesMock.mockReset();
  });

  it("does not poll nodes while another tab is active", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearInterval: globalThis.clearInterval,
      setInterval: globalThis.setInterval,
    });
    const host = createHost();

    startNodesPolling(host as never);
    vi.advanceTimersByTime(NODES_ACTIVE_POLL_INTERVAL_MS);
    expect(loadNodesMock).not.toHaveBeenCalled();

    host.tab = "nodes";
    vi.advanceTimersByTime(NODES_ACTIVE_POLL_INTERVAL_MS);
    expect(loadNodesMock).toHaveBeenCalledWith(host, { quiet: true });

    stopNodesPolling(host as never);
  });
});
