// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const { NODES_ACTIVE_POLL_INTERVAL_MS, startNodesPolling, stopNodesPolling } =
  await import("./app-polling.ts");

function createHost(request = vi.fn(async () => ({ nodes: [] }))) {
  return {
    client: { request },
    connected: true,
    nodesLoading: false,
    nodes: [],
    lastError: null,
    nodesPollInterval: null,
    logsPollInterval: null,
    debugPollInterval: null,
    tab: "overview",
  };
}

describe("startNodesPolling", () => {
  let testHost: ReturnType<typeof createHost> | null = null;

  afterEach(() => {
    if (testHost) {
      stopNodesPolling(testHost as never);
      testHost = null;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not poll nodes while another tab is active", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearInterval: globalThis.clearInterval,
      setInterval: globalThis.setInterval,
    });
    const request = vi.fn(async () => ({ nodes: [] }));
    const host = createHost(request);
    testHost = host;

    startNodesPolling(host as never);
    vi.advanceTimersByTime(NODES_ACTIVE_POLL_INTERVAL_MS);
    expect(request).not.toHaveBeenCalled();

    host.tab = "nodes";
    vi.advanceTimersByTime(NODES_ACTIVE_POLL_INTERVAL_MS);
    expect(request).toHaveBeenCalledWith("node.list", {});

    stopNodesPolling(host as never);
  });
});
