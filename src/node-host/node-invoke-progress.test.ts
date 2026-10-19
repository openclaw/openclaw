import { describe, expect, it, vi } from "vitest";
import type { NodeHostClient } from "./client.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";
import { NodeHostWorkerBridgeClient } from "./worker-support.js";

const frame = {
  id: "invoke-1",
  nodeId: "node-1",
  command: "test.duplex",
  paramsJSON: null,
  timeoutMs: 0,
  idempotencyKey: null,
};

describe("node invoke progress writer", () => {
  it("chunks output to 16 KiB", async () => {
    const request = vi.fn(async () => ({}));
    const client = { request } as NodeHostClient;
    const writer = createNodeInvokeProgressWriter({
      client,
      frame,
      idleTimeoutMs: 30_000,
      onError: vi.fn(),
    });

    await writer.write("é".repeat(10_000));
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, params] of request.mock.calls as unknown as Array<[string, { chunk: string }]>) {
      expect(Buffer.byteLength(params.chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it.each([
    { idleTimeoutMs: 100, heartbeatIntervalMs: 250 },
    { idleTimeoutMs: 2_000, heartbeatIntervalMs: 1_000 },
    { idleTimeoutMs: 60_000, heartbeatIntervalMs: 5_000 },
  ])(
    "emits idle heartbeats every $heartbeatIntervalMs ms for a $idleTimeoutMs ms timeout",
    async ({ idleTimeoutMs, heartbeatIntervalMs }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const request = vi.fn(async () => ({}));
        const writer = createNodeInvokeProgressWriter({
          client: { request } as NodeHostClient,
          frame,
          idleTimeoutMs,
          onError: vi.fn(),
        });
        writer.startHeartbeats();
        await vi.advanceTimersByTimeAsync(heartbeatIntervalMs - 1);
        expect(request).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledWith(
          "node.invoke.progress",
          {
            invokeId: "invoke-1",
            nodeId: "node-1",
            seq: 0,
            chunk: "",
          },
          undefined,
        );
        writer.stop();
        await writer.flush();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("invocation-owned progress cancellation", () => {
  it("releases a cancelled progress wait and queued chunks without cancelling another request", async () => {
    vi.useFakeTimers();
    const messages: Array<Record<string, unknown>> = [];
    const client = new NodeHostWorkerBridgeClient((message) =>
      messages.push(message as Record<string, unknown>),
    );
    client.setConnection(1, true);
    const controller = new AbortController();
    const writer = createNodeInvokeProgressWriter({
      client,
      frame,
      idleTimeoutMs: 30_000,
      signal: controller.signal,
      onError: vi.fn(),
    });
    try {
      const unrelated = client.request("skills.bins");
      void writer.write("first");
      void writer.write("queued");
      await vi.advanceTimersByTimeAsync(1);
      expect(messages.map((message) => message.method)).toEqual([
        "skills.bins",
        "node.invoke.progress",
      ]);
      let flushed = false;
      void writer.flush().then(() => {
        flushed = true;
      });
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(flushed).toBe(true);
      expect(messages).toHaveLength(2);
      expect(
        client.handleResponse({
          type: "gateway-response",
          generation: 1,
          id: "gateway-2",
          ok: true,
          result: {},
        }),
      ).toBe(false);
      expect(
        client.handleResponse({
          type: "gateway-response",
          generation: 1,
          id: "gateway-1",
          ok: true,
          result: { bins: [] },
        }),
      ).toBe(true);
      await expect(unrelated).resolves.toEqual({ bins: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      writer.stop();
      client.close();
      vi.useRealTimers();
    }
  });

  it("does not send a worker request whose signal is already aborted", async () => {
    const send = vi.fn();
    const client = new NodeHostWorkerBridgeClient(send);
    client.setConnection(1, true);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before progress"));
    let rejected = false;
    const request = client
      .request("node.invoke.progress", {}, { signal: controller.signal })
      .catch(() => {
        rejected = true;
      });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(rejected).toBe(true);
    client.close();
    await request;
  });
});
