import { describe, expect, it } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(overrides: {
  instanceId?: string;
  deviceId?: string;
  clientId?: string;
  connId?: string;
}): GatewayWsClient {
  return {
    connId: overrides.connId ?? "conn-1",
    socket: { send: () => {} } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: (overrides.clientId ?? "node-host") as "node-host",
        version: "1.0.0",
        platform: "linux",
        mode: "node" as const,
        instanceId: overrides.instanceId,
      },
      ...(overrides.deviceId ? { device: { id: overrides.deviceId } } : {}),
    },
  } as GatewayWsClient;
}

describe("NodeRegistry", () => {
  describe("register – nodeId resolution", () => {
    it("uses instanceId (--node-id) when provided", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ instanceId: "my-custom-node" });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("my-custom-node");
    });

    it("trims whitespace from instanceId", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ instanceId: "  my-node  " });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("my-node");
    });

    it("prefers instanceId over device.id", () => {
      const registry = new NodeRegistry();
      const client = makeClient({
        instanceId: "custom-id",
        deviceId: "device-uuid-123",
      });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("custom-id");
    });

    it("falls back to device.id when instanceId is absent", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ deviceId: "device-uuid-123" });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("device-uuid-123");
    });

    it("falls back to client.id when both instanceId and device.id are absent", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ clientId: "node-host" });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("node-host");
    });

    it("ignores empty-string instanceId", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ instanceId: "", deviceId: "device-uuid" });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("device-uuid");
    });

    it("ignores whitespace-only instanceId", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ instanceId: "   ", deviceId: "device-uuid" });
      const session = registry.register(client, {});
      expect(session.nodeId).toBe("device-uuid");
    });
  });

  describe("get / listConnected", () => {
    it("can retrieve registered node by custom nodeId", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ instanceId: "my-node", connId: "c1" });
      registry.register(client, {});
      expect(registry.get("my-node")).toBeDefined();
      expect(registry.get("my-node")!.connId).toBe("c1");
      expect(registry.listConnected()).toHaveLength(1);
    });
  });

  describe("unregister", () => {
    it("removes node registered with custom instanceId", () => {
      const registry = new NodeRegistry();
      const client = makeClient({ instanceId: "my-node", connId: "c1" });
      registry.register(client, {});
      expect(registry.unregister("c1")).toBe("my-node");
      expect(registry.get("my-node")).toBeUndefined();
    });
  });
});
