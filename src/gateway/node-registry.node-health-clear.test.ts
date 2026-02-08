import { afterEach, describe, expect, it } from "vitest";
import type { ConnectParams } from "./protocol/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  clearNodeHealthFramesForNode,
  getLatestNodeHealthFrames,
  upsertNodeHealthFrame,
} from "./node-health.js";
import { NodeRegistry } from "./node-registry.js";

describe("node registry disconnect cleanup", () => {
  afterEach(() => {
    clearNodeHealthFramesForNode("node-1");
  });

  it("clears node health frames on unregister", () => {
    const registry = new NodeRegistry();

    const connect: ConnectParams = {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "node-host",
        displayName: "node",
        platform: "test",
        version: "0",
        deviceFamily: "test",
        modelIdentifier: "test",
        mode: "node",
      },
      device: {
        id: "node-1",
        publicKey: "pk",
        signature: "sig",
        signedAt: 1,
      },
      role: "node",
      caps: [],
    };

    const client: GatewayWsClient = {
      connId: "c1",
      socket: {
        send: () => {},
      } as never,
      connect,
    };

    // Register a node session.
    registry.register(client, {});

    upsertNodeHealthFrame({ nodeId: "node-1", frame: { ts: Date.now(), data: { ok: true } } });
    expect(getLatestNodeHealthFrames().map((e) => e.nodeId)).toEqual(["node-1"]);

    registry.unregister("c1");
    expect(getLatestNodeHealthFrames()).toEqual([]);
  });
});
