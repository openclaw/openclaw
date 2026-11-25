import { expect, it, vi } from "vitest";
import { NODE_WORKER_PROCESSES_COMMAND } from "../../infra/node-commands.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createManager, environment, transport } from "./node-worker-tunnel.test-support.js";

it.each(["authority", "epoch", "connection"] as const)(
  "discards private process results after %s changes",
  async (change) => {
    const record = environment();
    const nodeTransport = transport();
    const result = createDeferredCore<{ ok: true; payloadJSON: string }>();
    const entered = createDeferredCore();
    let authorized = true;
    let connected = true;
    nodeTransport.isCurrent = () => connected;
    nodeTransport.invoke = vi.fn(async (request) => {
      expect(request.command).toBe(NODE_WORKER_PROCESSES_COMMAND);
      expect(request.isDispatchAuthorized()).toBe(true);
      entered.resolve();
      return result.promise;
    });
    const manager = createManager(record, { getTransport: () => nodeTransport });
    const pending = manager.observeProcesses(
      {
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        sessionId: "session-1",
        placementGeneration: 1,
        expectedBundleHash: record.bootstrapReceipt!.bundleHash,
        operation: { action: "list" },
      },
      () => {
        if (!authorized) {
          throw new Error("Request authority changed");
        }
      },
    );
    const rejected = expect(pending).rejects.toThrow(/changed|unavailable/);
    await entered.promise;
    if (change === "authority") {
      authorized = false;
    }
    if (change === "epoch") {
      record.ownerEpoch++;
    }
    if (change === "connection") {
      connected = false;
    }
    result.resolve({
      ok: true,
      payloadJSON: JSON.stringify({ sessionId: "session-1", processes: [], truncated: false }),
    });
    await rejected;
  },
);

it("reports an older or missing process endpoint as unavailable rather than empty success", async () => {
  const record = environment();
  const nodeTransport = transport();
  const invoke = vi.fn(async () => ({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unknown command" },
  }));
  nodeTransport.invoke = invoke;
  const manager = createManager(record, { getTransport: () => nodeTransport });
  await expect(
    manager.observeProcesses(
      {
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        sessionId: "session-1",
        placementGeneration: 1,
        expectedBundleHash: record.bootstrapReceipt!.bundleHash,
        operation: { action: "list" },
      },
      () => {},
    ),
  ).rejects.toThrow("unavailable");
  expect(invoke).toHaveBeenCalledOnce();
});
