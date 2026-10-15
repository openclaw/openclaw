import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodePendingWorkHandlers } from "./nodes.pending-work.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  captureNodePairingGeneration: vi.fn(),
  captureNodeWakeLifecycle: vi.fn(),
  drainNodePendingWork: vi.fn(),
  enqueueNodePendingWork: vi.fn(),
  isNodePairingGenerationCurrent: vi.fn(),
  isNodeWakeLifecycleCurrent: vi.fn(),
  maybeWakeNodeWithApns: vi.fn(),
  maybeSendNodeWakeNudge: vi.fn(),
  removeNodePendingWorkItem: vi.fn(),
  releaseNodeWakeLifecycle: vi.fn(),
  waitForNodeReconnect: vi.fn(),
}));
vi.mock("../node-pending-work.js", () => ({
  drainNodePendingWork: mocks.drainNodePendingWork,
  enqueueNodePendingWork: mocks.enqueueNodePendingWork,
  removeNodePendingWorkItem: mocks.removeNodePendingWorkItem,
}));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: mocks.captureNodePairingGeneration,
  isNodePairingGenerationCurrent: mocks.isNodePairingGenerationCurrent,
}));
vi.mock("../node-wake-state.js", () => ({
  NODE_WAKE_RECONNECT_WAIT_MS: 3_000,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS: 12_000,
  captureNodeWakeLifecycle: mocks.captureNodeWakeLifecycle,
  isNodeWakeLifecycleCurrent: mocks.isNodeWakeLifecycleCurrent,
  releaseNodeWakeLifecycle: mocks.releaseNodeWakeLifecycle,
}));
vi.mock("./nodes.wake.js", () => ({
  maybeWakeNodeWithApns: mocks.maybeWakeNodeWithApns,
  maybeSendNodeWakeNudge: mocks.maybeSendNodeWakeNudge,
  waitForNodeReconnect: mocks.waitForNodeReconnect,
}));

const nodeId = "node-1";
const generation = { nodeId, key: "generation-1" };
const item = { id: "pending-1", type: "location.request", priority: "high" };
let lifecycle: AbortController;

function makeContext(
  getSession: () => { connId: string; pairingGeneration?: string } | undefined = () => undefined,
) {
  return {
    nodeRegistry: {
      get: vi.fn(getSession),
      getForPairingGeneration: vi.fn(getSession),
      isConnectionCurrentPairingState: vi.fn(async () => true),
    },
    logGateway: { info: vi.fn(), warn: vi.fn() },
    getRuntimeConfig: () => ({}),
  };
}

async function callPending(
  method: "node.pending.drain" | "node.pending.enqueue",
  params: Record<string, unknown>,
  context = makeContext(),
  client: GatewayClient | null = null,
) {
  const respond = vi.fn();
  await nodePendingWorkHandlers[method]!({
    params,
    respond,
    client,
    context: context as never,
    req: { type: "req", id: method, method },
    isWebchatConnect: () => false,
  });
  return respond;
}

function drain(
  context = makeContext(() => ({ connId: "conn-1", pairingGeneration: generation.key })),
) {
  return callPending("node.pending.drain", { maxItems: 3 }, context, {
    connId: "conn-1",
    connect: { device: { id: nodeId } },
  } as never);
}
function enqueue(params = {}, context = makeContext()) {
  return callPending("node.pending.enqueue", { nodeId, type: item.type, ...params }, context);
}
function expectPairingChanged(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ details: { code: "PAIRING_CHANGED" } }),
  );
}

describe("node.pending handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lifecycle = new AbortController();
    mocks.captureNodePairingGeneration.mockResolvedValue(generation);
    mocks.captureNodeWakeLifecycle.mockReturnValue(lifecycle.signal);
    mocks.isNodePairingGenerationCurrent.mockResolvedValue(true);
    mocks.isNodeWakeLifecycleCurrent.mockImplementation(
      (_nodeId: string, signal: AbortSignal) => !signal.aborted,
    );
    mocks.enqueueNodePendingWork.mockReturnValue({ revision: 4, deduped: false, item });
    mocks.maybeWakeNodeWithApns.mockResolvedValue({
      available: true,
      throttled: false,
      path: "sent",
      durationMs: 0,
    });
    mocks.maybeSendNodeWakeNudge.mockResolvedValue({
      sent: false,
      throttled: false,
      reason: "no-registration",
      durationMs: 0,
    });
  });

  it("drains pending work for the connected node identity", async () => {
    const drained = {
      revision: 2,
      items: [{ id: "baseline-status", type: "status.request" }],
      hasMore: false,
    };
    mocks.drainNodePendingWork.mockReturnValue(drained);
    expect(await drain()).toHaveBeenCalledWith(true, { nodeId, ...drained }, undefined);
    expect(mocks.drainNodePendingWork).toHaveBeenCalledWith(nodeId, {
      maxItems: 3,
      includeDefaultStatus: true,
      pairingGeneration: generation.key,
    });
  });

  it("rejects node.pending.drain without a connected device identity", async () => {
    expect(await callPending("node.pending.drain", {})).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("connected device identity") }),
    );
    expect(mocks.drainNodePendingWork).not.toHaveBeenCalled();
  });

  it("rejects a changed pairing before draining its pending work", async () => {
    const context = makeContext(() => ({ connId: "conn-1", pairingGeneration: generation.key }));
    context.nodeRegistry.isConnectionCurrentPairingState.mockResolvedValue(false);
    expectPairingChanged(await drain(context));
    expect(mocks.drainNodePendingWork).not.toHaveBeenCalled();
  });

  it("rejects a same-generation reconnect before destructively draining", async () => {
    let connId = "conn-1";
    const context = makeContext(() => ({ connId, pairingGeneration: generation.key }));
    context.nodeRegistry.isConnectionCurrentPairingState.mockImplementation(async () => {
      connId = "replacement";
      return true;
    });
    expectPairingChanged(await drain(context));
    expect(mocks.drainNodePendingWork).not.toHaveBeenCalled();
  });

  it("normalizes the target identity before queueing and waking a disconnected node", async () => {
    let connected = false;
    const context = makeContext(() => (connected ? { connId: "conn-1" } : undefined));
    mocks.waitForNodeReconnect.mockImplementation(async () => {
      connected = true;
      return true;
    });
    const respond = await enqueue({ nodeId: ` ${nodeId} `, priority: "high" }, context);
    expect(mocks.enqueueNodePendingWork).toHaveBeenCalledWith({
      nodeId,
      type: item.type,
      priority: "high",
      expiresInMs: undefined,
      pairingGeneration: generation.key,
    });
    expect(context.nodeRegistry.getForPairingGeneration).toHaveBeenCalledWith(
      nodeId,
      generation.key,
    );
    expect(mocks.maybeWakeNodeWithApns).toHaveBeenCalledWith(nodeId, {
      wakeReason: "node.pending",
      cfg: {},
      lifecycle: lifecycle.signal,
      generation,
    });
    expect(mocks.waitForNodeReconnect).toHaveBeenCalledWith({
      nodeId,
      context,
      timeoutMs: 3_000,
      lifecycle: lifecycle.signal,
      pairingGeneration: generation.key,
    });
    expect(mocks.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(mocks.releaseNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, lifecycle.signal);
    expect(respond).toHaveBeenCalledWith(
      true,
      { nodeId, revision: 4, queued: item, wakeTriggered: true },
      undefined,
    );
  });

  it.each([
    { available: true, forces: [undefined, true], timeouts: [3_000, 12_000] },
    { available: false, forces: [undefined], timeouts: [] },
  ])(
    "retries a disconnected node only when its first wake is available=$available",
    async ({ available, forces, timeouts }) => {
      mocks.maybeWakeNodeWithApns.mockResolvedValue({
        available,
        throttled: false,
        path: available ? "sent" : "no-registration",
        durationMs: 0,
      });
      mocks.waitForNodeReconnect.mockResolvedValue(false);
      const respond = await enqueue();
      expect(mocks.maybeWakeNodeWithApns.mock.calls.map(([, options]) => options.force)).toEqual(
        forces,
      );
      expect(mocks.waitForNodeReconnect.mock.calls.map(([options]) => options.timeoutMs)).toEqual(
        timeouts,
      );
      expect(mocks.maybeSendNodeWakeNudge).toHaveBeenCalledOnce();
      expect(mocks.removeNodePendingWorkItem).not.toHaveBeenCalled();
      expect(mocks.releaseNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, lifecycle.signal);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ wakeTriggered: available }),
        undefined,
      );
    },
  );

  it("does not enqueue work when pairing invalidates during the generation check", async () => {
    mocks.isNodePairingGenerationCurrent.mockImplementation(async () => {
      lifecycle.abort();
      return true;
    });
    expectPairingChanged(await enqueue({ wake: false }));
    expect(mocks.enqueueNodePendingWork).not.toHaveBeenCalled();
  });

  it("returns unavailable when pairing removal invalidates an enqueued item", async () => {
    mocks.waitForNodeReconnect.mockImplementation(async () => {
      lifecycle.abort();
      return false;
    });
    expectPairingChanged(await enqueue());
    expect(mocks.captureNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, generation.key);
    expect(mocks.maybeWakeNodeWithApns).toHaveBeenCalledExactlyOnceWith(nodeId, {
      wakeReason: "node.pending",
      cfg: {},
      lifecycle: lifecycle.signal,
      generation,
    });
    expect(mocks.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(mocks.releaseNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, lifecycle.signal);
    expect(mocks.removeNodePendingWorkItem).toHaveBeenCalledWith({
      nodeId,
      itemId: item.id,
      pairingGeneration: generation.key,
    });
  });

  it("does not remove replacement work when an invalidated enqueue reused it", async () => {
    mocks.enqueueNodePendingWork.mockReturnValue({ revision: 9, deduped: true, item });
    mocks.isNodePairingGenerationCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expectPairingChanged(await enqueue({ wake: false }));
    expect(mocks.enqueueNodePendingWork).toHaveBeenCalledOnce();
    expect(mocks.removeNodePendingWorkItem).not.toHaveBeenCalled();
  });
});
