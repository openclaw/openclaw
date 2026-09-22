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

  it("keeps a promoted connection's transport when the stale lookup resolves late", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const resolveConnectionPairingState = vi.fn().mockResolvedValue("stale");
    const pairingGenerationForConnection = vi.fn().mockReturnValue("generation-1");
    // The connection is promoted while the lookup awaits persistence, so the atomic
    // retirement compares generations and preserves the session.
    const retireRejectedConnection = vi.fn().mockReturnValue("preserve");
    const disconnectClientForConnection = vi.fn();
    const invalidateConnectionForPairingChange = vi.fn().mockReturnValue(false);

    await handleGatewayRequest({
      req: {
        type: "req",
        id: "req-node-promoted",
        method: "node.event",
        params: { event: "test" },
      },
      respond,
      client: nodeClientFixture({ connId: "conn-node-promoted", deviceId: "node-promoted" }),
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: {
          resolveConnectionPairingState,
          pairingGenerationForConnection,
          retireRejectedConnection,
          invalidateConnectionForPairingChange,
        },
        disconnectClientForConnection,
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(resolveConnectionPairingState).toHaveBeenCalledTimes(1);
    expect(disconnectClientForConnection).not.toHaveBeenCalled();
    expect(invalidateConnectionForPairingChange).not.toHaveBeenCalled();
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
    const pairingGenerationForConnection = vi.fn().mockReturnValue("generation-1");
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
        nodeRegistry: {
          resolveConnectionPairingState,
          pairingGenerationForConnection,
          invalidateConnectionForPairingChange,
        },
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
  it("rejects every node RPC when its connection no longer owns the pairing generation", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const respond = vi.fn();
    const resolveConnectionPairingState = vi.fn().mockResolvedValue("stale");
    const pairingGenerationForConnection = vi.fn().mockReturnValue("generation-1");
    const retireRejectedConnection = vi.fn().mockReturnValue("retire");
    const disconnectClientForConnection = vi.fn();
    const invalidateConnectionForPairingChange = vi.fn().mockReturnValue(false);

    await handleGatewayRequest({
      req: { type: "req", id: "req-node-stale", method: "node.event", params: { event: "test" } },
      respond,
      client: {
        connId: "conn-node-stale",
        connect: {
          role: "node",
          scopes: [],
          device: {
            id: "node-stale",
            publicKey: "public-key",
            signature: "signature",
            signedAt: 1,
            nonce: "nonce",
          },
          client: { id: "node-host", version: "1", platform: "test", mode: "node" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
        nodeRegistry: {
          resolveConnectionPairingState,
          pairingGenerationForConnection,
          retireRejectedConnection,
          invalidateConnectionForPairingChange,
        },
        disconnectClientForConnection,
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      extraHandlers: { "node.event": handler },
    });

    expect(resolveConnectionPairingState).toHaveBeenCalledWith("conn-node-stale");
    // Retirement stays scoped to the rejected connection and lands only after the
    // rejection frame, so a same-device replacement keeps its transport.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(pairingGenerationForConnection).toHaveBeenCalledWith("conn-node-stale");
    expect(retireRejectedConnection).toHaveBeenCalledWith({
      connId: "conn-node-stale",
      observedGeneration: "generation-1",
      reason: "node pairing changed before request dispatch",
    });
    expect(disconnectClientForConnection).toHaveBeenCalledWith(
      "conn-node-stale",
      "node pairing changed before request dispatch",
    );
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
