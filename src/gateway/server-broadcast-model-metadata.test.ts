import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function clientWithScopes(scopes: string[]) {
  const send = vi.fn((_payload: string) => {});
  const client: GatewayWsClient = {
    connId: scopes.join(","),
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", mode: "webchat", version: "test", platform: "test" },
    },
    socket: { readyState: 1, bufferedAmount: 0, send } as unknown as GatewayWsClient["socket"],
  };
  const frames = (): unknown[] => send.mock.calls.map(([raw]) => JSON.parse(raw));
  return { client, send, frames };
}

describe("model metadata invalidation broadcasts", () => {
  it.each(["operator.sessions.read", "operator.sessions.write"])(
    "delivers only bounded invalidations to %s",
    (scope) => {
      const narrow = clientWithScopes([scope]);
      const staff = clientWithScopes(["operator.read"]);
      const pairing = clientWithScopes(["operator.pairing"]);
      const node = clientWithScopes(["operator.read"]);
      node.client.connect.role = "node";
      node.client.connId = "node";
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([
          staff.client,
          narrow.client,
          pairing.client,
          node.client,
        ]),
      });
      const getter = vi.fn(() => true);
      for (const payload of [
        { models: ["example/restricted-model"] },
        { modelSelectionChanged: true, model: "example/restricted-model" },
        {
          get modelSelectionChanged() {
            return getter();
          },
        },
        { toJSON: () => ({}) },
        new Proxy({}, {}),
      ]) {
        broadcast("chat.metadata.changed", payload);
      }
      expect(narrow.frames()).toEqual([]);
      expect(staff.send).toHaveBeenCalledTimes(5);
      expect(getter).toHaveBeenCalledOnce();
      broadcast("config.changed", { path: "/private/example-config", hash: "example-hash", ts: 1 });
      broadcast("chat.metadata.changed", {});
      broadcast("chat.metadata.changed", { modelSelectionChanged: true });
      expect(narrow.frames()).toEqual([
        { type: "event", event: "chat.metadata.changed", seq: 1, payload: {} },
        {
          type: "event",
          event: "chat.metadata.changed",
          seq: 2,
          payload: { modelSelectionChanged: true },
        },
      ]);
      expect(pairing.frames()).toEqual([]);
      expect(node.frames()).toEqual([]);
    },
  );
});
