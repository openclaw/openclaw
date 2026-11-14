import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  NodeHostWorkerBridgeClient,
  parseNodeHostWorkerInput,
  stopNodeHostWorkerFromSignal,
} from "./worker-support.js";

it.each([
  { type: "invoke-input", generation: 1, invokeId: "invoke-1", seq: 2, payloadJSON: "x" },
  { type: "invoke-cancel", generation: 1, invokeId: "invoke-1" },
  null,
])("parses worker control frame %j", (frame) => {
  expect(parseNodeHostWorkerInput(frame === null ? "{" : JSON.stringify(frame))).toEqual(frame);
});

describe("NodeHostWorkerBridgeClient", () => {
  const write = vi.fn();
  const responseFrame = { type: "gateway-response", generation: 1, id: "gateway-1" } as const;
  let client: NodeHostWorkerBridgeClient;
  beforeEach(() => {
    write.mockClear();
    client = new NodeHostWorkerBridgeClient(write);
    client.setConnection(1, true);
  });
  afterEach(() => client.close());
  const messages = () => write.mock.calls.map(([message]) => message);

  it("does not send a worker request whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before progress"));
    await expect(
      client.request("node.invoke.progress", {}, { signal: controller.signal }),
    ).rejects.toThrow("cancelled before progress");
    expect(write).not.toHaveBeenCalled();
  });

  it("fences pending RPCs and retained invocation output after route replacement", async () => {
    const pending = client.request("skills.bins");
    const rejected = expect(pending).rejects.toThrow("route changed");
    const gate = createDeferredCore();
    const late = client.withConnection(1, async () => {
      await gate.promise;
      return client.request("node.event", { event: "exec.finished" });
    });
    const lateRejected = expect(late).rejects.toThrow("route is closed");
    client.setConnection(2, true);
    gate.resolve();
    await Promise.all([rejected, lateRejected]);
    expect(client.handleResponse({ ...responseFrame, ok: true, result: {} })).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves structured gateway rejection for the shared publisher", async () => {
    const error = { code: "INVALID_REQUEST", message: "unknown method: node.skills.update" };
    const response = client.request("node.skills.update");
    const rejection = expect(response).rejects.toMatchObject({
      gatewayCode: error.code,
      message: error.message,
    });
    client.handleResponse({ ...responseFrame, ok: false, error });
    await rejection;
    await expect(response).rejects.toBeInstanceOf(GatewayClientRequestError);
  });

  it("forwards invoke results and events without creating gateway request waits", async () => {
    await client.request("node.invoke.result", { id: "invoke-1", ok: true });
    await client.request("node.event", { event: "exec.started", payloadJSON: "{}" });

    expect(messages()).toEqual([
      { type: "invoke-result", generation: 1, result: { id: "invoke-1", ok: true } },
      { type: "node-event", generation: 1, event: { event: "exec.started", payloadJSON: "{}" } },
    ]);
  });

  it("tunnels invoke progress and waits for gateway acceptance", async () => {
    let settled = false;
    const params = { invokeId: "invoke-1", nodeId: "node-1", seq: 0, chunk: "a" };
    const response = client.request("node.invoke.progress", params).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(messages()).toEqual([
      {
        type: "gateway-request",
        generation: 1,
        id: "gateway-1",
        method: "node.invoke.progress",
        params,
        timeoutMs: 15_000,
      },
    ]);

    expect(client.handleResponse({ ...responseFrame, ok: true, result: { ok: true } })).toBe(true);
    await response;
    expect(settled).toBe(true);
  });
});

it("preserves the signal exit code when closing stdin emits EOF", async () => {
  const stop = vi.fn(async (_exitCode: number) => {});
  await stopNodeHostWorkerFromSignal({ close: () => void stop(0) }, stop, 143);
  expect(stop.mock.calls).toEqual([[143], [0]]);
});
