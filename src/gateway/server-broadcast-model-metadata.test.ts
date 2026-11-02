import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

function clientWithScopes(scopes: string[]) {
  const { client, socket } = makeClient(scopes.join(","), "operator", scopes);
  const { send } = socket;
  const frames = (): unknown[] => send.mock.calls.map(([raw]) => JSON.parse(raw));
  return { client, send, frames };
}

describe("model metadata invalidation broadcasts", () => {
  it("delivers only bounded invalidations to session readers", () => {
    const narrow = clientWithScopes(["operator.sessions.read"]);
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
      { modelCatalogChanged: "false" },
      { authChanged: true, profileId: "private-profile" },
      Object.defineProperty({}, "authChanged", { value: false }),
    ]) {
      broadcast("chat.metadata.changed", payload);
    }
    expect(narrow.frames()).toEqual([]);
    expect(staff.send).toHaveBeenCalledTimes(8);
    expect(getter).toHaveBeenCalledOnce();
    broadcast("config.changed", { path: "/private/example-config", hash: "example-hash", ts: 1 });
    broadcast("chat.metadata.changed", {});
    broadcast("chat.metadata.changed", { modelSelectionChanged: true });
    broadcast("chat.metadata.changed", { modelCatalogChanged: false, authChanged: false });
    broadcast("chat.metadata.changed", { modelCatalogChanged: true, authChanged: false });
    broadcast("chat.metadata.changed", { modelCatalogChanged: true, authChanged: true });
    expect(narrow.frames()).toEqual(
      [
        {},
        { modelSelectionChanged: true },
        { modelCatalogChanged: false, authChanged: false },
        { modelCatalogChanged: true, authChanged: false },
        { modelCatalogChanged: true, authChanged: true },
      ].map((payload, index) => ({
        type: "event",
        event: "chat.metadata.changed",
        seq: index + 1,
        payload,
      })),
    );
    expect(pairing.frames()).toEqual([]);
    expect(node.frames()).toEqual([]);
  });
});
