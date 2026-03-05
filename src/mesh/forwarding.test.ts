import { describe, expect, it, vi, beforeEach } from "vitest";
import { forwardMessageToPeer } from "./forwarding.js";
import { PeerRegistry } from "./peer-registry.js";
import type { PeerSession } from "./types.js";

function createMockSocket() {
  const send = vi.fn();
  const close = vi.fn();
  return {
    socket: { send, close, readyState: 1 } as unknown as PeerSession["socket"],
    send,
    close,
  };
}

describe("forwardMessageToPeer()", () => {
  let peerRegistry: PeerRegistry;

  beforeEach(() => {
    peerRegistry = new PeerRegistry();
  });

  it("invokes mesh.message.forward RPC on the target peer", async () => {
    const { socket, send } = createMockSocket();
    peerRegistry.register({
      deviceId: "peer-b",
      connId: "conn-1",
      socket,
      outbound: true,
      capabilities: ["channel:telegram"],
      connectedAtMs: Date.now(),
    });

    // Start the forward — it will pend waiting for RPC response
    const forwardPromise = forwardMessageToPeer({
      peerRegistry,
      peerDeviceId: "peer-b",
      channel: "telegram",
      to: "user-123",
      message: "Hello from mesh",
      originGatewayId: "local-gw",
    });

    // Verify the RPC was sent
    expect(send).toHaveBeenCalledOnce();
    const sentFrame = JSON.parse(send.mock.calls[0][0] as string);
    expect(sentFrame.type).toBe("req");
    expect(sentFrame.method).toBe("mesh.message.forward");
    expect(sentFrame.params.channel).toBe("telegram");
    expect(sentFrame.params.to).toBe("user-123");
    expect(sentFrame.params.message).toBe("Hello from mesh");
    expect(sentFrame.params.originGatewayId).toBe("local-gw");

    // Respond to complete the RPC
    peerRegistry.handleRpcResult({
      id: sentFrame.id,
      ok: true,
      payload: { messageId: "msg-abc" },
    });

    const result = await forwardPromise;
    expect(result).toEqual({ ok: true, messageId: "msg-abc" });
  });

  it("includes originGatewayId for loop prevention", async () => {
    const { socket, send } = createMockSocket();
    peerRegistry.register({
      deviceId: "peer-b",
      connId: "conn-1",
      socket,
      outbound: true,
      capabilities: [],
      connectedAtMs: Date.now(),
    });

    const forwardPromise = forwardMessageToPeer({
      peerRegistry,
      peerDeviceId: "peer-b",
      channel: "whatsapp",
      to: "user-456",
      originGatewayId: "gateway-origin",
    });

    const sentFrame = JSON.parse(send.mock.calls[0][0] as string);
    expect(sentFrame.params.originGatewayId).toBe("gateway-origin");

    peerRegistry.handleRpcResult({ id: sentFrame.id, ok: true, payload: {} });
    await forwardPromise;
  });

  it("returns { ok: true, messageId } on success", async () => {
    const { socket, send } = createMockSocket();
    peerRegistry.register({
      deviceId: "peer-b",
      connId: "conn-1",
      socket,
      outbound: true,
      capabilities: [],
      connectedAtMs: Date.now(),
    });

    const forwardPromise = forwardMessageToPeer({
      peerRegistry,
      peerDeviceId: "peer-b",
      channel: "telegram",
      to: "user-1",
      message: "hi",
      originGatewayId: "gw-1",
    });

    const sentFrame = JSON.parse(send.mock.calls[0][0] as string);
    peerRegistry.handleRpcResult({
      id: sentFrame.id,
      ok: true,
      payload: { messageId: "msg-xyz" },
    });

    const result = await forwardPromise;
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-xyz");
  });

  it("returns { ok: false, error } on RPC failure", async () => {
    const result = await forwardMessageToPeer({
      peerRegistry,
      peerDeviceId: "nonexistent-peer",
      channel: "telegram",
      to: "user-1",
      originGatewayId: "gw-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("generates idempotencyKey when not provided", async () => {
    const { socket, send } = createMockSocket();
    peerRegistry.register({
      deviceId: "peer-b",
      connId: "conn-1",
      socket,
      outbound: true,
      capabilities: [],
      connectedAtMs: Date.now(),
    });

    const forwardPromise = forwardMessageToPeer({
      peerRegistry,
      peerDeviceId: "peer-b",
      channel: "telegram",
      to: "user-1",
      originGatewayId: "gw-1",
    });

    const sentFrame = JSON.parse(send.mock.calls[0][0] as string);
    expect(sentFrame.params.idempotencyKey).toBeTruthy();
    expect(typeof sentFrame.params.idempotencyKey).toBe("string");

    peerRegistry.handleRpcResult({ id: sentFrame.id, ok: true, payload: {} });
    await forwardPromise;
  });
});
