import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeNodeRequest } from "./nodes.invoke.test-support.js";
import { nodePendingWorkHandlers } from "./nodes.pending-work.js";
import type { GatewayClient } from "./types.js";

const { pairing, work, wakeState, wake } = vi.hoisted(() => ({
  pairing: { captureNodePairingGeneration: vi.fn(), isNodePairingGenerationCurrent: vi.fn() },
  work: {
    drainNodePendingWork: vi.fn(),
    enqueueNodePendingWork: vi.fn(),
    removeNodePendingWorkItem: vi.fn(),
  },
  wakeState: {
    NODE_WAKE_RECONNECT_WAIT_MS: 3_000,
    NODE_WAKE_RECONNECT_RETRY_WAIT_MS: 12_000,
    captureNodeWakeLifecycle: vi.fn(),
    isNodeWakeLifecycleCurrent: vi.fn(),
    releaseNodeWakeLifecycle: vi.fn(),
  },
  wake: {
    maybeWakeNodeWithApns: vi.fn(),
    maybeSendNodeWakeNudge: vi.fn(),
    waitForNodeReconnect: vi.fn(),
  },
}));
// mock-isolation: Pending work is owned by this fixture, not persistent Gateway state.
vi.mock("../node-pending-work.js", () => work);
// mock-isolation: Pairing generations are synthetic and must not read host pairings.
vi.mock("../../infra/device-pairing-node-state.js", () => pairing);
// mock-isolation: Wake lifecycle state is synthetic and must not read or change host nodes.
vi.mock("../node-wake-state.js", () => wakeState);
// mock-isolation: Exercise wake decisions without sending APNs or waking real nodes.
vi.mock("./nodes.wake.js", () => wake);

const nodeId = "node-1";
const generation = { nodeId, key: "generation-1" };
const item = { id: "pending-1", type: "location.request", priority: "high" };
let lifecycle: AbortController;
const wakeOptions = () => ({
  wakeReason: "node.pending",
  cfg: {},
  lifecycle: lifecycle.signal,
  generation,
});
function expectReply(respond: ReturnType<typeof vi.fn>, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

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

async function request(
  kind: "drain" | "enqueue",
  params: Record<string, unknown> = {},
  context = makeContext(
    kind === "drain" ? () => ({ connId: "conn-1", pairingGeneration: generation.key }) : undefined,
  ),
  client: GatewayClient | null = kind === "drain"
    ? ({ connId: "conn-1", connect: { device: { id: nodeId } } } as GatewayClient)
    : null,
) {
  const method = `node.pending.${kind}`;
  return invokeNodeRequest(nodePendingWorkHandlers[method]!, context as never, client, method, {
    ...(kind === "drain" ? { maxItems: 3 } : { nodeId, type: item.type }),
    ...params,
  });
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
    pairing.captureNodePairingGeneration.mockResolvedValue(generation);
    wakeState.captureNodeWakeLifecycle.mockReturnValue(lifecycle.signal);
    pairing.isNodePairingGenerationCurrent.mockResolvedValue(true);
    wakeState.isNodeWakeLifecycleCurrent.mockImplementation(
      (_nodeId: string, signal: AbortSignal) => !signal.aborted,
    );
    work.enqueueNodePendingWork.mockReturnValue({ revision: 4, deduped: false, item });
    wake.maybeWakeNodeWithApns.mockResolvedValue({ available: true });
    wake.maybeSendNodeWakeNudge.mockResolvedValue({});
  });

  it("drains pending work for the connected node identity", async () => {
    const drained = {
      revision: 2,
      items: [{ id: "baseline-status", type: "status.request" }],
      hasMore: false,
    };
    work.drainNodePendingWork.mockReturnValue(drained);
    expect(await request("drain")).toHaveBeenCalledWith(true, { nodeId, ...drained }, undefined);
    expect(work.drainNodePendingWork).toHaveBeenCalledWith(nodeId, {
      maxItems: 3,
      includeDefaultStatus: true,
      pairingGeneration: generation.key,
    });
  });

  it.each(["missing identity", "changed pairing", "same-generation reconnect"])(
    "rejects %s before destructively draining",
    async (reason) => {
      let connId = "conn-1";
      const context = makeContext(() => ({ connId, pairingGeneration: generation.key }));
      context.nodeRegistry.isConnectionCurrentPairingState.mockImplementation(async () => {
        connId = "replacement";
        return reason === "same-generation reconnect";
      });
      if (reason === "missing identity") {
        expect(await request("drain", {}, undefined, null)).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining("connected device identity"),
          }),
        );
      } else {
        expectPairingChanged(await request("drain", {}, context));
      }
      expect(work.drainNodePendingWork).not.toHaveBeenCalled();
    },
  );

  it("normalizes the target identity before queueing and waking a disconnected node", async () => {
    let connected = false;
    const context = makeContext(() => (connected ? { connId: "conn-1" } : undefined));
    wake.waitForNodeReconnect.mockImplementation(async () => {
      connected = true;
      return true;
    });
    const respond = await request("enqueue", { nodeId: ` ${nodeId} `, priority: "high" }, context);
    expect(work.enqueueNodePendingWork).toHaveBeenCalledWith({
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
    expect(wake.maybeWakeNodeWithApns).toHaveBeenCalledWith(nodeId, wakeOptions());
    expect(wake.waitForNodeReconnect).toHaveBeenCalledWith({
      nodeId,
      context,
      timeoutMs: 3_000,
      lifecycle: lifecycle.signal,
      pairingGeneration: generation.key,
    });
    expect(wake.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(wakeState.releaseNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, lifecycle.signal);
    expectReply(respond, { nodeId, revision: 4, queued: item, wakeTriggered: true });
  });

  it.each([
    { available: true, forces: [undefined, true], timeouts: [3_000, 12_000] },
    { available: false, forces: [undefined], timeouts: [] },
  ])(
    "retries a disconnected node only when its first wake is available=$available",
    async ({ available, forces, timeouts }) => {
      wake.maybeWakeNodeWithApns.mockResolvedValue({ available });
      wake.waitForNodeReconnect.mockResolvedValue(false);
      const respond = await request("enqueue");
      expect(wake.maybeWakeNodeWithApns.mock.calls.map(([, options]) => options.force)).toEqual(
        forces,
      );
      expect(wake.waitForNodeReconnect.mock.calls.map(([options]) => options.timeoutMs)).toEqual(
        timeouts,
      );
      expect(wake.maybeSendNodeWakeNudge).toHaveBeenCalledOnce();
      expect(work.removeNodePendingWorkItem).not.toHaveBeenCalled();
      expect(wakeState.releaseNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, lifecycle.signal);
      expectReply(respond, expect.objectContaining({ wakeTriggered: available }));
    },
  );

  it("does not enqueue work when pairing invalidates during the generation check", async () => {
    pairing.isNodePairingGenerationCurrent.mockImplementation(async () => {
      lifecycle.abort();
      return true;
    });
    expectPairingChanged(await request("enqueue", { wake: false }));
    expect(work.enqueueNodePendingWork).not.toHaveBeenCalled();
  });

  it("returns unavailable when pairing removal invalidates an enqueued item", async () => {
    wake.waitForNodeReconnect.mockImplementation(async () => {
      lifecycle.abort();
      return false;
    });
    expectPairingChanged(await request("enqueue"));
    expect(wakeState.captureNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, generation.key);
    expect(wake.maybeWakeNodeWithApns).toHaveBeenCalledExactlyOnceWith(nodeId, wakeOptions());
    expect(wake.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(wakeState.releaseNodeWakeLifecycle).toHaveBeenCalledWith(nodeId, lifecycle.signal);
    expect(work.removeNodePendingWorkItem).toHaveBeenCalledWith({
      nodeId,
      itemId: item.id,
      pairingGeneration: generation.key,
    });
  });

  it("does not remove replacement work when an invalidated enqueue reused it", async () => {
    work.enqueueNodePendingWork.mockReturnValue({ revision: 9, deduped: true, item });
    pairing.isNodePairingGenerationCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expectPairingChanged(await request("enqueue", { wake: false }));
    expect(work.enqueueNodePendingWork).toHaveBeenCalledOnce();
    expect(work.removeNodePendingWorkItem).not.toHaveBeenCalled();
  });
});
