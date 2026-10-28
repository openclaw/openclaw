import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.useRealTimers());

function progressWriter(
  client: NodeHostClient,
  options: Partial<Parameters<typeof createNodeInvokeProgressWriter>[0]> = {},
) {
  return createNodeInvokeProgressWriter({
    client,
    frame,
    idleTimeoutMs: 30_000,
    onError: vi.fn(),
    ...options,
  });
}

it("chunks output to 16 KiB", async () => {
  const request = vi.fn(async () => ({}));
  const writer = progressWriter({ request } as NodeHostClient);

  await writer.write("é".repeat(10_000));
  expect(request).toHaveBeenCalledTimes(2);
  for (const [, params] of request.mock.calls as unknown as Array<[string, { chunk: string }]>) {
    expect(Buffer.byteLength(params.chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
  }
});

it.each([
  [100, 250, 0],
  [2_000, 1_000, 0],
  [60_000, 5_000, 0],
  [30_000, 5_000, -30_000],
  [30_000, 5_000, 30_000],
])(
  "idle %i ms: heartbeat every %i ms with clock skew %i ms",
  async (idleTimeoutMs, heartbeatIntervalMs, skewMs) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const request = vi.fn(async () => ({}));
    const writer = progressWriter({ request } as NodeHostClient, { idleTimeoutMs });
    vi.setSystemTime(skewMs);
    writer.startHeartbeats();
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs - 1);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "node.invoke.progress",
      { invokeId: "invoke-1", nodeId: "node-1", seq: 0, chunk: "" },
      undefined,
    );
    writer.stop();
    await writer.flush();
  },
);
it("releases a cancelled progress wait and queued chunks without cancelling another request", async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const client = new NodeHostWorkerBridgeClient(send);
  client.setConnection(1, true);
  const respond = (id: string, result: unknown) =>
    client.handleResponse({
      type: "gateway-response",
      generation: 1,
      id,
      ok: true,
      result,
    });
  const controller = new AbortController();
  const writer = progressWriter(client, { signal: controller.signal });
  try {
    const unrelated = client.request("skills.bins");
    void writer.write("first");
    void writer.write("queued");
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls).toMatchObject([
      [{ method: "skills.bins" }],
      [{ method: "node.invoke.progress" }],
    ]);
    const flushed = vi.fn();
    void writer.flush().then(flushed);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(respond("gateway-2", {})).toBe(false);
    expect(respond("gateway-1", { bins: [] })).toBe(true);
    await expect(unrelated).resolves.toEqual({ bins: [] });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    writer.stop();
    client.close();
  }
});
