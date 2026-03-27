import { describe, expect, it, vi } from "vitest";
import { NodeRegistry } from "./node-registry.js";

function makeMockClient(nodeId: string) {
  return {
    socket: {
      send: vi.fn(),
    },
    connect: {
      device: { id: nodeId },
      client: {
        id: nodeId,
        displayName: `Node ${nodeId}`,
        platform: "test",
        version: "1.0",
      },
      caps: [],
    },
    connId: `conn-${nodeId}`,
  } as unknown as Parameters<NodeRegistry["register"]>[0];
}

describe("NodeRegistry invoke timeout", () => {
  it("defaults invoke timeout to 5s when no explicit timeout is provided", async () => {
    const registry = new NodeRegistry();
    const client = makeMockClient("node-1");
    registry.register(client, {});

    const invokePromise = registry.invoke({
      nodeId: "node-1",
      command: "test.command",
    });

    // Simulate the node responding immediately with a result.
    // We need to find the pending invoke's request ID from the send mock.
    const sendCalls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.length).toBe(1);
    const sentMessage = JSON.parse(sendCalls[0][0] as string);
    expect(sentMessage.type).toBe("event");
    expect(sentMessage.event).toBe("node.invoke.request");
    const requestId = sentMessage.payload.id;

    // The timeout in the payload should reflect the 5s default.
    expect(sentMessage.payload.timeoutMs).toBeUndefined();

    // Resolve the pending invoke.
    registry.handleInvokeResult({
      id: requestId,
      nodeId: "node-1",
      ok: true,
      payload: { result: "ok" },
    });

    const result = await invokePromise;
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ result: "ok" });
  });

  it("times out after ~5s by default (not 30s) for unreachable nodes", async () => {
    vi.useFakeTimers();
    try {
      const registry = new NodeRegistry();
      const client = makeMockClient("node-2");
      registry.register(client, {});

      const invokePromise = registry.invoke({
        nodeId: "node-2",
        command: "test.slow",
      });

      // Advance time by 5s -- the new default timeout.
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects explicit timeoutMs override", async () => {
    vi.useFakeTimers();
    try {
      const registry = new NodeRegistry();
      const client = makeMockClient("node-3");
      registry.register(client, {});

      const invokePromise = registry.invoke({
        nodeId: "node-3",
        command: "test.custom",
        timeoutMs: 10_000,
      });

      // At 5s the invoke should still be pending (custom 10s timeout).
      await vi.advanceTimersByTimeAsync(5_000);

      // Advance to 10s -- now it should timeout.
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await invokePromise;
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });
});
