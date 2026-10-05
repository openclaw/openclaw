import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_INVOKE_PROGRESS_DIAGNOSTIC_EVENT } from "../../shared/node-invoke-progress-diagnostic.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient, registerNodeSession } from "../node-registry.test-helpers.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { nodeEventHandlers } from "./nodes.event.js";

const observation = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (subsystem: string) => {
      const logger = original.createSubsystemLogger(subsystem);
      return subsystem === "gateway/node-duplex" ? { ...logger, info: observation } : logger;
    },
  };
});
afterEach(() => vi.restoreAllMocks());

it("accepts only bounded safe metadata for the exact authenticated live invocation", async () => {
  observation.mockReset();
  let authorized = true;
  let generation = "generation-a";
  const registry = new NodeRegistry({
    getConfig: () => ({ gateway: { nodes: { commands: { allow: ["system.run"] } } } }),
    resolveCurrentPairingState: async () => ({ identity: "identity-a", generation }),
  });
  const client = makeClient("conn-1", "node-1", [], { commands: ["system.run"] });
  registerNodeSession(registry, client, { pairingGeneration: "generation-a" });
  const dispatched = createDeferred<string>();
  const invocation = registry.invokeLifecycle({
    nodeId: "node-1",
    command: "system.run",
    params: { command: ["fixture"] },
    timeoutMs: 60_000,
    onProgress: () => {},
    isDispatchAuthorized: () => authorized,
    onDispatchReady: (id) => dispatched.resolve(id),
  });
  const context = createContext();
  context.nodeRegistry = registry;
  try {
    const invokeId = await Promise.race([
      dispatched.promise,
      invocation.then((result) => {
        throw new Error(`Fixture invocation did not dispatch: ${JSON.stringify(result)}`);
      }),
    ]);
    const snapshot = {
      invokeId,
      stage: "sample",
      category: "registered_command",
      disposition: "active",
      atMs: 0,
      nextSeq: 1,
      lastSentSeq: 0,
      lastCompletedSeq: 0,
      pendingSeq: null,
      progressRequestId: "wire-1",
      sourceWrites: 1,
      lastSourceAtMs: 0,
      lastSentAtMs: 0,
      lastCompletedAtMs: 0,
      requestFailed: false,
    };
    const send = async (payload: unknown, sender = client) => {
      const params = { event: NODE_INVOKE_PROGRESS_DIAGNOSTIC_EVENT, payload };
      const respond = vi.fn();
      await nodeEventHandlers["node.event"]({
        req: { type: "req", id: "diagnostic", method: "node.event", params },
        params,
        client: sender,
        respond,
        context,
        isWebchatConnect: () => false,
      });
      return respond;
    };
    const received = await send(snapshot);
    expect(received).toHaveBeenCalledWith(true, expect.objectContaining({ handled: true }));
    expect(observation).toHaveBeenCalledWith(
      "node invoke progress state",
      expect.objectContaining({
        nodeId: "node-1",
        invokeId,
        lastSentSeq: 0,
        receiverNextProgressSeq: 0,
      }),
    );
    const count = observation.mock.calls.length;
    await send(snapshot);
    await send({ ...snapshot, privateBody: "private-token" });
    await send({ ...snapshot, invokeId: "other-invoke" });
    await send(snapshot, makeClient("wrong-conn", "node-1"));
    await send(snapshot, makeClient(client.connId, "node-1"));
    expect(observation).toHaveBeenCalledTimes(count);
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_001);
    try {
      expect(await send({ ...snapshot, stage: "request_failed" })).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ handled: false }),
      );
    } finally {
      clock.mockRestore();
    }
    authorized = false;
    const authorityClosed = await send({ ...snapshot, stage: "request_failed" });
    expect(authorityClosed).toHaveBeenCalledWith(true, expect.objectContaining({ handled: false }));
    expect(observation).toHaveBeenCalledTimes(count);
    expect(JSON.stringify(observation.mock.calls)).not.toContain("private");
    authorized = true;
    // A refused observation must leave the owner's invocation pending and usable.
    expect(registry.isInvokeCurrent(invokeId, "node-1", client.connId)).toBe(true);
    observation.mockImplementationOnce(() => {
      throw new Error("sink unavailable");
    });
    expect(await send({ ...snapshot, stage: "stopped" })).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ handled: true }),
    );
    expect(registry.isInvokeCurrent(invokeId, "node-1", client.connId)).toBe(true);
    registry.handleInvokeResult({
      id: invokeId,
      nodeId: "node-1",
      connId: client.connId,
      ok: true,
    });
    expect(await invocation).toMatchObject({ ok: true });
    expect(await send({ ...snapshot, stage: "settled" })).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ handled: false }),
    );
    generation = "generation-retired";
    expect(await send(snapshot)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ handled: false }),
    );
    expect(client.invalidated).toBe(true);
  } finally {
    registry.unregister(client.connId);
    await invocation;
  }
});
