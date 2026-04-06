import { describe, expect, it } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(overrides: {
  instanceId?: string;
  deviceId?: string;
  clientId?: string;
}): GatewayWsClient {
  return {
    socket: { send: () => {} } as unknown as GatewayWsClient["socket"],
    connId: "conn-1",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: (overrides.clientId ?? "node-host") as "node-host",
        version: "1.0.0",
        platform: "darwin",
        mode: "node",
        instanceId: overrides.instanceId,
      },
      ...(overrides.deviceId
        ? { device: { id: overrides.deviceId, publicKey: "k", signature: "s", signedAt: 0, nonce: "n" } }
        : {}),
    },
  };
}

describe("NodeRegistry", () => {
  describe("register", () => {
    it("uses instanceId as nodeId when provided", () => {
      const registry = new NodeRegistry();
      const session = registry.register(makeClient({ instanceId: "my-custom-node" }), {});
      expect(session.nodeId).toBe("my-custom-node");
      expect(registry.get("my-custom-node")).toBe(session);
    });

    it("prefers instanceId over device id", () => {
      const registry = new NodeRegistry();
      const session = registry.register(
        makeClient({ instanceId: "custom-id", deviceId: "device-uuid" }),
        {},
      );
      expect(session.nodeId).toBe("custom-id");
    });

    it("falls back to device id when no instanceId", () => {
      const registry = new NodeRegistry();
      const session = registry.register(makeClient({ deviceId: "device-uuid" }), {});
      expect(session.nodeId).toBe("device-uuid");
    });

    it("falls back to client id when no instanceId or device", () => {
      const registry = new NodeRegistry();
      const session = registry.register(makeClient({}), {});
      expect(session.nodeId).toBe("node-host");
    });
  });
});
