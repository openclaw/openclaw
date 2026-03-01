import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeHandlers } from "./nodes.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  approveNodePairing: vi.fn(),
  getNodePendingRequest: vi.fn(),
  listNodePairing: vi.fn(),
  rejectNodePairing: vi.fn(),
  requestNodePairing: vi.fn(),
  renamePairedNode: vi.fn(),
  verifyNodeToken: vi.fn(),
  listDevicePairing: vi.fn(),
  getDevicePendingRequest: vi.fn(),
  approveDevicePairing: vi.fn(),
  rejectDevicePairing: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../infra/node-pairing.js", () => ({
  approveNodePairing: mocks.approveNodePairing,
  getNodePendingRequest: mocks.getNodePendingRequest,
  listNodePairing: mocks.listNodePairing,
  rejectNodePairing: mocks.rejectNodePairing,
  requestNodePairing: mocks.requestNodePairing,
  renamePairedNode: mocks.renamePairedNode,
  verifyNodeToken: mocks.verifyNodeToken,
}));

vi.mock("../../infra/device-pairing.js", () => ({
  approveDevicePairing: mocks.approveDevicePairing,
  getDevicePendingRequest: mocks.getDevicePendingRequest,
  listDevicePairing: mocks.listDevicePairing,
  rejectDevicePairing: mocks.rejectDevicePairing,
}));

vi.mock("../../infra/push-apns.js", () => ({
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
}));

function makeContext() {
  return {
    broadcast: vi.fn(),
    nodeRegistry: { get: vi.fn(), listConnected: vi.fn(() => []) },
    logGateway: { info: vi.fn(), warn: vi.fn() },
  } as never;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    fn.mockReset();
  }
});

describe("node.pair.approve", () => {
  it("approves the device entry using persisted deviceRequestId and broadcasts device.pair.resolved", async () => {
    const nodeId = "test-node-1";
    const nodeRequestId = "node-req-1";
    const deviceRequestId = "device-req-1";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    mocks.approveNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      node: { nodeId, token: "tok" },
      deviceRequestId,
    });
    mocks.getDevicePendingRequest.mockResolvedValue({
      requestId: deviceRequestId,
      deviceId: nodeId,
      role: "node",
      roles: ["node"],
      ts: Date.now(),
    });
    mocks.approveDevicePairing.mockResolvedValue({
      requestId: deviceRequestId,
      device: { deviceId: nodeId },
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.approve"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r1", method: "node.pair.approve" },
      isWebchatConnect: () => false,
    });

    expect(mocks.approveNodePairing).toHaveBeenCalledWith(nodeRequestId);
    // Uses deviceRequestId directly — no listDevicePairing scan.
    expect(mocks.listDevicePairing).not.toHaveBeenCalled();
    expect(mocks.approveDevicePairing).toHaveBeenCalledWith(deviceRequestId);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);

    // Should broadcast both device.pair.resolved and node.pair.resolved.
    const broadcastCalls = (context as { broadcast: ReturnType<typeof vi.fn> }).broadcast.mock
      .calls;
    const deviceResolved = broadcastCalls.find((c: unknown[]) => c[0] === "device.pair.resolved");
    expect(deviceResolved).toBeDefined();
    expect(deviceResolved![1]).toMatchObject({
      requestId: deviceRequestId,
      deviceId: nodeId,
      decision: "approved",
    });
    const nodeResolved = broadcastCalls.find((c: unknown[]) => c[0] === "node.pair.resolved");
    expect(nodeResolved).toBeDefined();
    expect(nodeResolved![1]).toMatchObject({
      requestId: nodeRequestId,
      nodeId,
      decision: "approved",
    });
  });

  it("does not touch device store when no deviceRequestId is present", async () => {
    const nodeRequestId = "node-req-2";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId: "orphan-node",
      // No deviceRequestId — legacy or node-only entry.
      ts: Date.now(),
    });
    mocks.approveNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      node: { nodeId: "orphan-node", token: "tok" },
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.approve"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r2", method: "node.pair.approve" },
      isWebchatConnect: () => false,
    });

    expect(mocks.approveDevicePairing).not.toHaveBeenCalled();
    expect(mocks.listDevicePairing).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);

    // No device.pair.resolved broadcast when no deviceRequestId.
    const broadcastCalls = (context as { broadcast: ReturnType<typeof vi.fn> }).broadcast.mock
      .calls;
    const deviceResolved = broadcastCalls.find((c: unknown[]) => c[0] === "device.pair.resolved");
    expect(deviceResolved).toBeUndefined();
  });

  it("returns error when device entry has mixed roles — neither store is modified", async () => {
    const nodeId = "mixed-node-1";
    const nodeRequestId = "node-req-mixed-1";
    const deviceRequestId = "device-req-mixed-1";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    // Device entry has accumulated both "node" and "operator" roles via merge.
    mocks.getDevicePendingRequest.mockResolvedValue({
      requestId: deviceRequestId,
      deviceId: nodeId,
      role: "operator",
      roles: ["operator", "node"],
      ts: Date.now(),
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.approve"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r-mixed-1", method: "node.pair.approve" },
      isWebchatConnect: () => false,
    });

    // Neither store should be modified.
    expect(mocks.approveNodePairing).not.toHaveBeenCalled();
    expect(mocks.approveDevicePairing).not.toHaveBeenCalled();
    // Should return an error directing the user to device.pair.approve.
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("mixed roles"),
      }),
    );
  });

  it("skips device sync when role merge occurs between pre-flight and mutation (approve)", async () => {
    const nodeId = "postmut-mixed-node-1";
    const nodeRequestId = "node-req-postmut-1";
    const deviceRequestId = "device-req-postmut-1";

    // Pre-flight: device entry is node-only (passes the early-out check).
    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    // First call (pre-flight) returns node-only; second call (post-mutation)
    // returns mixed roles — simulates a concurrent role merge.
    let callCount = 0;
    mocks.getDevicePendingRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          requestId: deviceRequestId,
          deviceId: nodeId,
          role: "node",
          roles: ["node"],
          ts: Date.now(),
        };
      }
      return {
        requestId: deviceRequestId,
        deviceId: nodeId,
        role: "operator",
        roles: ["operator", "node"],
        ts: Date.now(),
      };
    });
    mocks.approveNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      node: { nodeId, token: "tok" },
      deviceRequestId,
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.approve"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r-postmut-1", method: "node.pair.approve" },
      isWebchatConnect: () => false,
    });

    // Post-mutation validation should catch the mixed-role merge.
    expect(mocks.approveNodePairing).toHaveBeenCalledWith(nodeRequestId);
    expect(mocks.approveDevicePairing).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(
      (context as { logGateway: { warn: ReturnType<typeof vi.fn> } }).logGateway.warn,
    ).toHaveBeenCalledWith(expect.stringContaining("skipping device sync"));
  });

  it("proceeds with device approval when device entry is not found (already expired)", async () => {
    const nodeId = "expired-node-1";
    const nodeRequestId = "node-req-expired-1";
    const deviceRequestId = "device-req-expired-1";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    // Device pending entry already expired/pruned — returns null.
    mocks.getDevicePendingRequest.mockResolvedValue(null);
    mocks.approveNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      node: { nodeId, token: "tok" },
      deviceRequestId,
    });
    mocks.approveDevicePairing.mockResolvedValue(null);

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.approve"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r-expired-1", method: "node.pair.approve" },
      isWebchatConnect: () => false,
    });

    // When the pending entry is gone, proceed with approveDevicePairing
    // (it will return null harmlessly).
    expect(mocks.approveDevicePairing).toHaveBeenCalledWith(deviceRequestId);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });
});

describe("node.pair.reject", () => {
  it("rejects the device entry using persisted deviceRequestId and broadcasts device.pair.resolved", async () => {
    const nodeId = "test-node-3";
    const nodeRequestId = "node-req-3";
    const deviceRequestId = "device-req-3";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    mocks.rejectNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
    });
    mocks.getDevicePendingRequest.mockResolvedValue({
      requestId: deviceRequestId,
      deviceId: nodeId,
      role: "node",
      roles: ["node"],
      ts: Date.now(),
    });
    mocks.rejectDevicePairing.mockResolvedValue({
      requestId: deviceRequestId,
      deviceId: nodeId,
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.reject"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r3", method: "node.pair.reject" },
      isWebchatConnect: () => false,
    });

    expect(mocks.rejectNodePairing).toHaveBeenCalledWith(nodeRequestId);
    expect(mocks.listDevicePairing).not.toHaveBeenCalled();
    expect(mocks.rejectDevicePairing).toHaveBeenCalledWith(deviceRequestId);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);

    const broadcastCalls = (context as { broadcast: ReturnType<typeof vi.fn> }).broadcast.mock
      .calls;
    const deviceResolved = broadcastCalls.find((c: unknown[]) => c[0] === "device.pair.resolved");
    expect(deviceResolved).toBeDefined();
    expect(deviceResolved![1]).toMatchObject({
      requestId: deviceRequestId,
      deviceId: nodeId,
      decision: "rejected",
    });
  });

  it("does not touch device store when no deviceRequestId is present", async () => {
    const nodeRequestId = "node-req-4";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId: "orphan-node-2",
      ts: Date.now(),
    });
    mocks.rejectNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId: "orphan-node-2",
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.reject"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r4", method: "node.pair.reject" },
      isWebchatConnect: () => false,
    });

    expect(mocks.rejectDevicePairing).not.toHaveBeenCalled();
    expect(mocks.listDevicePairing).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });

  it("returns error when device entry has mixed roles — neither store is modified", async () => {
    const nodeId = "mixed-node-2";
    const nodeRequestId = "node-req-mixed-2";
    const deviceRequestId = "device-req-mixed-2";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    // Device entry has accumulated both "node" and "operator" roles via merge.
    mocks.getDevicePendingRequest.mockResolvedValue({
      requestId: deviceRequestId,
      deviceId: nodeId,
      role: "node",
      roles: ["node", "operator"],
      ts: Date.now(),
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.reject"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r-mixed-2", method: "node.pair.reject" },
      isWebchatConnect: () => false,
    });

    // Neither store should be modified.
    expect(mocks.rejectNodePairing).not.toHaveBeenCalled();
    expect(mocks.rejectDevicePairing).not.toHaveBeenCalled();
    // Should return an error directing the user to device.pair.reject.
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("mixed roles"),
      }),
    );
  });

  it("skips device sync when role merge occurs between pre-flight and mutation (reject)", async () => {
    const nodeId = "postmut-mixed-node-2";
    const nodeRequestId = "node-req-postmut-2";
    const deviceRequestId = "device-req-postmut-2";

    // Pre-flight: device entry is node-only (passes the early-out check).
    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    // First call (pre-flight) returns node-only; second call (post-mutation)
    // returns mixed roles — simulates a concurrent role merge.
    let callCount = 0;
    mocks.getDevicePendingRequest.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          requestId: deviceRequestId,
          deviceId: nodeId,
          role: "node",
          roles: ["node"],
          ts: Date.now(),
        };
      }
      return {
        requestId: deviceRequestId,
        deviceId: nodeId,
        role: "operator",
        roles: ["operator", "node"],
        ts: Date.now(),
      };
    });
    mocks.rejectNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
    });

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.reject"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r-postmut-2", method: "node.pair.reject" },
      isWebchatConnect: () => false,
    });

    // Post-mutation validation should catch the mixed-role merge.
    expect(mocks.rejectNodePairing).toHaveBeenCalledWith(nodeRequestId);
    expect(mocks.rejectDevicePairing).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(
      (context as { logGateway: { warn: ReturnType<typeof vi.fn> } }).logGateway.warn,
    ).toHaveBeenCalledWith(expect.stringContaining("skipping device sync"));
  });

  it("proceeds with device rejection when device entry is not found (already expired)", async () => {
    const nodeId = "expired-node-2";
    const nodeRequestId = "node-req-expired-2";
    const deviceRequestId = "device-req-expired-2";

    mocks.getNodePendingRequest.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
      ts: Date.now(),
    });
    // Device pending entry already expired/pruned — returns null.
    mocks.getDevicePendingRequest.mockResolvedValue(null);
    mocks.rejectNodePairing.mockResolvedValue({
      requestId: nodeRequestId,
      nodeId,
      deviceRequestId,
    });
    mocks.rejectDevicePairing.mockResolvedValue(null);

    const context = makeContext();
    const respond = vi.fn();
    await nodeHandlers["node.pair.reject"]({
      params: { requestId: nodeRequestId },
      respond: respond as never,
      context,
      client: null,
      req: { type: "req", id: "r-expired-2", method: "node.pair.reject" },
      isWebchatConnect: () => false,
    });

    // When the pending entry is gone, proceed with rejectDevicePairing
    // (it will return null harmlessly).
    expect(mocks.rejectDevicePairing).toHaveBeenCalledWith(deviceRequestId);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });
});
