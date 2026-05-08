import { describe, expect, test } from "vitest";
import { NodeRegistry, type NodeSession } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(connId: string, nodeId = "node-1"): GatewayWsClient {
  return {
    connId,
    socket: {
      send: () => undefined,
      readyState: 1,
    } as GatewayWsClient["socket"],
    usesSharedGatewayAuth: false,
    connect: {
      role: "node",
      device: { id: nodeId },
      client: {
        id: "openclaw-android",
        mode: "node",
        displayName: "Android",
        platform: "android",
        version: "test",
      },
      caps: [],
      commands: ["health.steps"],
    } as GatewayWsClient["connect"],
  };
}

function onlyConnected(registry: NodeRegistry): NodeSession {
  const sessions = registry.listConnected();
  expect(sessions).toHaveLength(1);
  return sessions[0]!;
}

describe("NodeRegistry", () => {
  test("stale connection close does not remove a newer session for the same node", () => {
    const registry = new NodeRegistry();
    const oldSession = registry.register(makeClient("old-conn"), {});
    const newSession = registry.register(makeClient("new-conn"), {});

    expect(oldSession.nodeId).toBe(newSession.nodeId);
    expect(onlyConnected(registry).connId).toBe("new-conn");

    expect(registry.unregister("old-conn")).toBe("node-1");

    expect(onlyConnected(registry).connId).toBe("new-conn");
    expect(registry.get("node-1")?.connId).toBe("new-conn");
  });
});
