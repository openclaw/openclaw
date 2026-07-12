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
    lastError: null as string | null,
    chatError: null as string | null,
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

  it("polls nodes quietly only while the nodes tab is active", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      clearInterval: globalThis.clearInterval,
      setInterval: globalThis.setInterval,
    });
    const request = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const host = createHost(request);
    host.lastError = "existing error";
    host.chatError = "existing chat error";
    testHost = host;

    startNodesPolling(host as never);
    await vi.advanceTimersByTimeAsync(NODES_ACTIVE_POLL_INTERVAL_MS);
    expect(request).not.toHaveBeenCalled();

    host.tab = "nodes";
    await vi.advanceTimersByTimeAsync(NODES_ACTIVE_POLL_INTERVAL_MS);
    expect(request).toHaveBeenCalledWith("node.list", {});
    expect(host.nodesLoading).toBe(false);
    expect(host.lastError).toBe("existing error");
    expect(host.chatError).toBe("existing chat error");

    stopNodesPolling(host as never);
  });
});
