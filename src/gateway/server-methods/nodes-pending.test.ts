/**
 * Tests pending-node gateway method responses and state filtering.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodePendingHandlers } from "./nodes-pending.js";

const mocks = vi.hoisted(() => ({
  captureNodePairingGeneration: vi.fn(),
  captureNodeWakeLifecycle: vi.fn(),
  drainNodePendingWork: vi.fn(),
  enqueueNodePendingWork: vi.fn(),
  isNodePairingGenerationCurrent: vi.fn(),
  isNodeWakeLifecycleCurrent: vi.fn(),
  maybeWakeNodeWithApns: vi.fn(),
  maybeSendNodeWakeNudge: vi.fn(),
  releaseNodeWakeLifecycle: vi.fn(),
  waitForNodeReconnect: vi.fn(),
}));

vi.mock("../node-pending-work.js", () => ({
  drainNodePendingWork: mocks.drainNodePendingWork,
  enqueueNodePendingWork: mocks.enqueueNodePendingWork,
}));

vi.mock("./node-pairing-generation.js", () => ({
  captureNodePairingGeneration: mocks.captureNodePairingGeneration,
  isNodePairingGenerationCurrent: mocks.isNodePairingGenerationCurrent,
}));

vi.mock("./nodes.js", () => ({
  NODE_WAKE_RECONNECT_WAIT_MS: 3_000,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS: 12_000,
  captureNodeWakeLifecycle: mocks.captureNodeWakeLifecycle,
  isNodeWakeLifecycleCurrent: mocks.isNodeWakeLifecycleCurrent,
  maybeWakeNodeWithApns: mocks.maybeWakeNodeWithApns,
  maybeSendNodeWakeNudge: mocks.maybeSendNodeWakeNudge,
  releaseNodeWakeLifecycle: mocks.releaseNodeWakeLifecycle,
  waitForNodeReconnect: mocks.waitForNodeReconnect,
}));

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

function makeContext(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeRegistry: {
      get: vi.fn(() => undefined),
    },
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    getRuntimeConfig: () => ({}),
    ...overrides,
  };
}

function respondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

describe("node.pending handlers", () => {
  beforeEach(() => {
    mocks.captureNodePairingGeneration.mockReset().mockImplementation(async (nodeId: string) => ({
      nodeId,
      key: `generation:${nodeId}:1`,
    }));
    mocks.captureNodeWakeLifecycle.mockReset();
    mocks.drainNodePendingWork.mockReset();
    mocks.enqueueNodePendingWork.mockReset();
    mocks.isNodePairingGenerationCurrent.mockReset().mockResolvedValue(true);
    mocks.isNodeWakeLifecycleCurrent
      .mockReset()
      .mockImplementation((_nodeId: string, lifecycle: AbortSignal) => !lifecycle.aborted);
    mocks.maybeWakeNodeWithApns.mockReset();
    mocks.maybeSendNodeWakeNudge.mockReset();
    mocks.releaseNodeWakeLifecycle.mockReset();
    mocks.waitForNodeReconnect.mockReset();
  });

  it("drains pending work for the connected node identity", async () => {
    mocks.drainNodePendingWork.mockReturnValue({
      revision: 2,
      items: [{ id: "baseline-status", type: "status.request", priority: "default" }],
      hasMore: false,
    });
    const respond = vi.fn();

    await expectDefined(
      nodePendingHandlers["node.pending.drain"],
      'nodePendingHandlers["node.pending.drain"] test invariant',
    )({
      params: { maxItems: 3 },
      respond: respond as never,
      client: { connect: { device: { id: "ios-node-1" } } } as never,
      context: makeContext() as never,
      req: { type: "req", id: "req-node-pending-drain", method: "node.pending.drain" },
      isWebchatConnect: () => false,
    });

    expect(mocks.drainNodePendingWork).toHaveBeenCalledWith("ios-node-1", {
      maxItems: 3,
      includeDefaultStatus: true,
      pairingGeneration: "generation:ios-node-1:1",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        nodeId: "ios-node-1",
        revision: 2,
        items: [{ id: "baseline-status", type: "status.request", priority: "default" }],
        hasMore: false,
      },
      undefined,
    );
  });

  it("rejects node.pending.drain without a connected device identity", async () => {
    const respond = vi.fn();

    await expectDefined(
      nodePendingHandlers["node.pending.drain"],
      'nodePendingHandlers["node.pending.drain"] test invariant',
    )({
      params: {},
      respond: respond as never,
      client: null,
      context: makeContext() as never,
      req: { type: "req", id: "req-node-pending-drain-missing", method: "node.pending.drain" },
      isWebchatConnect: () => false,
    });

    const call = respondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toContain("connected device identity");
  });

  it("normalizes the target identity before queueing and waking a disconnected node", async () => {
    const wakeLifecycle = new AbortController().signal;
    mocks.captureNodeWakeLifecycle.mockReturnValue(wakeLifecycle);
    mocks.enqueueNodePendingWork.mockReturnValue({
      revision: 4,
      deduped: false,
      item: {
        id: "pending-1",
        type: "location.request",
        priority: "high",
        createdAtMs: 100,
        expiresAtMs: null,
      },
    });
    mocks.maybeWakeNodeWithApns.mockResolvedValue({
      available: true,
      throttled: false,
      path: "apns",
      durationMs: 12,
      apnsStatus: 200,
      apnsReason: null,
    });
    let connected = false;
    mocks.waitForNodeReconnect.mockImplementation(async () => {
      connected = true;
      return true;
    });
    const context = makeContext({
      nodeRegistry: {
        get: vi.fn(() => (connected ? { nodeId: "ios-node-2" } : undefined)),
      },
    });
    const respond = vi.fn();

    await expectDefined(
      nodePendingHandlers["node.pending.enqueue"],
      'nodePendingHandlers["node.pending.enqueue"] test invariant',
    )({
      params: {
        nodeId: " ios-node-2 ",
        type: "location.request",
        priority: "high",
      },
      respond: respond as never,
      client: null,
      context: context as never,
      req: { type: "req", id: "req-node-pending-enqueue", method: "node.pending.enqueue" },
      isWebchatConnect: () => false,
    });

    expect(mocks.enqueueNodePendingWork).toHaveBeenCalledWith({
      nodeId: "ios-node-2",
      type: "location.request",
      priority: "high",
      expiresInMs: undefined,
      pairingGeneration: "generation:ios-node-2:1",
    });
    expect(context.nodeRegistry.get).toHaveBeenCalledWith("ios-node-2");
    expect(context.nodeRegistry.get).not.toHaveBeenCalledWith(" ios-node-2 ");
    expect(mocks.maybeWakeNodeWithApns).toHaveBeenCalledWith("ios-node-2", {
      wakeReason: "node.pending",
      cfg: {},
      lifecycle: wakeLifecycle,
    });
    expect(mocks.waitForNodeReconnect).toHaveBeenCalledWith({
      nodeId: "ios-node-2",
      context,
      timeoutMs: 3_000,
      lifecycle: wakeLifecycle,
    });
    expect(mocks.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(mocks.releaseNodeWakeLifecycle).toHaveBeenCalledWith("ios-node-2", wakeLifecycle);
    const call = respondCall(respond) as
      | [boolean, { nodeId?: string; revision?: number; wakeTriggered?: boolean }, unknown?]
      | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.nodeId).toBe("ios-node-2");
    expect(call?.[1]?.revision).toBe(4);
    expect(call?.[1]?.wakeTriggered).toBe(true);
    expect(call?.[2]).toBeUndefined();
  });

  it("returns unavailable when pairing removal invalidates an enqueued item", async () => {
    const lifecycleController = new AbortController();
    const wakeLifecycle = lifecycleController.signal;
    mocks.captureNodeWakeLifecycle.mockReturnValue(wakeLifecycle);
    mocks.enqueueNodePendingWork.mockReturnValue({
      revision: 5,
      deduped: false,
      item: {
        id: "pending-invalidated",
        type: "location.request",
        priority: "default",
        createdAtMs: 100,
        expiresAtMs: null,
      },
    });
    mocks.maybeWakeNodeWithApns.mockImplementation(async () =>
      wakeLifecycle.aborted
        ? {
            available: false,
            throttled: false,
            path: "invalidated",
            durationMs: 0,
          }
        : {
            available: true,
            throttled: false,
            path: "sent",
            durationMs: 1,
          },
    );
    mocks.waitForNodeReconnect.mockImplementation(async () => {
      lifecycleController.abort();
      return false;
    });
    mocks.maybeSendNodeWakeNudge.mockResolvedValue({
      sent: false,
      throttled: false,
      reason: "invalidated",
      durationMs: 0,
    });
    const context = makeContext();
    const respond = vi.fn();

    await expectDefined(
      nodePendingHandlers["node.pending.enqueue"],
      'nodePendingHandlers["node.pending.enqueue"] test invariant',
    )({
      params: { nodeId: " ios-node-invalidated ", type: "location.request" },
      respond: respond as never,
      client: null,
      context: context as never,
      req: { type: "req", id: "req-node-pending-invalidated", method: "node.pending.enqueue" },
      isWebchatConnect: () => false,
    });

    expect(mocks.captureNodeWakeLifecycle).toHaveBeenCalledWith("ios-node-invalidated");
    expect(mocks.maybeWakeNodeWithApns).toHaveBeenCalledTimes(1);
    for (const call of mocks.maybeWakeNodeWithApns.mock.calls) {
      expect(call[0]).toBe("ios-node-invalidated");
      expect(call[1]).toMatchObject({ lifecycle: wakeLifecycle });
    }
    expect(mocks.waitForNodeReconnect).toHaveBeenCalledWith({
      nodeId: "ios-node-invalidated",
      context,
      timeoutMs: 3_000,
      lifecycle: wakeLifecycle,
    });
    expect(mocks.maybeSendNodeWakeNudge).not.toHaveBeenCalled();
    expect(mocks.releaseNodeWakeLifecycle).toHaveBeenCalledWith(
      "ios-node-invalidated",
      wakeLifecycle,
    );
    const call = respondCall(respond);
    expect(call?.[0]).toBe(false);
    expect(call?.[2]).toMatchObject({
      message: "node pairing changed while pending work was active",
      details: { code: "PAIRING_CHANGED" },
    });
  });
});
