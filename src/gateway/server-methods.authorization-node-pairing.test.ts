import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/shared-types.js";

function nodeClientFixture(params: { connId?: string; deviceId: string }) {
  return {
    ...(params.connId ? { connId: params.connId } : {}),
    connect: {
      role: "node",
      scopes: [],
      device: {
        id: params.deviceId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
      client: { id: "node-host", version: "1", platform: "test", mode: "node" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

describe("gateway node pairing fence guards", () => {
  it("rejects node RPCs without a connId without touching the registry", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const resolveConnectionPairingState = vi.fn().mockResolvedValue("current");
    const invalidateConnectionForPairingChange = vi.fn().mockReturnValue(false);

    await handleGatewayRequest({
      req: { type: "req", id: "req-node-no-conn", method: "node.event", params: { event: "test" } },
      respond,
      client: nodeClientFixture({ deviceId: "node-no-conn" }),
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: { resolveConnectionPairingState, invalidateConnectionForPairingChange },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    expect(resolveConnectionPairingState).not.toHaveBeenCalled();
    expect(invalidateConnectionForPairingChange).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { code: "PAIRING_CHANGED" },
      }),
    );
  });

  it("keeps a retryable connection when the pairing store is unavailable", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const resolveConnectionPairingState = vi.fn().mockResolvedValue("unavailable");
    const invalidateConnectionForPairingChange = vi.fn().mockReturnValue(false);

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-node-unavailable",
        method: "node.event",
        params: { event: "test" },
      },
      respond,
      client: nodeClientFixture({
        connId: "conn-node-unavailable",
        deviceId: "node-unavailable",
      }),
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: { resolveConnectionPairingState, invalidateConnectionForPairingChange },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    expect(resolveConnectionPairingState).toHaveBeenCalledWith("conn-node-unavailable");
    expect(invalidateConnectionForPairingChange).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { code: "PAIRING_CHANGED" },
      }),
    );
  });
});
