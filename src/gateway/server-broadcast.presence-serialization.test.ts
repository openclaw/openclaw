import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemPresence } from "../infra/system-presence.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

afterEach(() => vi.restoreAllMocks());

describe("presence payload encoding", () => {
  it("encodes each presence audience once while retaining current authority and recipient stamps", () => {
    const peers = ["first", "second", "revoked", "pending"].map((id) =>
      makeClient(id, "operator", ["operator.read"]),
    );
    const visible = [{ text: "watcher", ts: 1, watchedSessions: ["agent:main:shared"] }];
    const hidden = [{ text: "watcher", ts: 1 }];
    let revoked = false;
    const project = vi.fn((client: GatewayWsClient) =>
      client.connId === "pending" || (client.connId === "revoked" && revoked) ? hidden : visible,
    );
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      preparePresenceProjection: () => project,
    });
    peers.forEach(({ client }) => {
      client.preparedRecipientProfileId = client.connId;
    });
    broadcastToConnIds("tick", {}, new Set(["second"]));
    peers[0]!.socket.send.mockImplementationOnce(() => {
      revoked = true;
    });
    const stringify = vi.spyOn(JSON, "stringify");
    const stateVersion = { presence: 3 };
    broadcast("presence", { presence: visible }, { stateVersion });
    const encodings = stringify.mock.calls.filter(
      ([value]) => value?.payload?.presence === visible || value?.payload?.presence === hidden,
    );
    stringify.mockRestore();

    expect(encodings).toHaveLength(2);
    expect(project).toHaveBeenCalledTimes(4);
    for (const [index, peer] of peers.entries()) {
      expect(peer.socket.send.mock.lastCall![0]).toBe(
        JSON.stringify({
          type: "event",
          event: "presence",
          payload: { presence: index < 2 ? visible : hidden },
          seq: index === 1 ? 2 : 1,
          stateVersion,
          recipientProfileId: peer.client.connId,
        }),
      );
    }

    visible[0]!.ts = 2;
    broadcast("presence", { presence: visible });
    expect(JSON.parse(peers[0]!.socket.send.mock.lastCall![0]).payload.presence[0].ts).toBe(2);
  });

  it.each(["getter", "toJSON", "proxy", "added field"])(
    "preserves presence payload %s changes between recipients",
    (publisher) => {
      const peers = [
        makeClient("first", "operator", ["operator.read"]),
        makeClient("second", "operator", ["operator.read"]),
      ];
      const presence = [{ text: "watcher", ts: 1 }];
      const hidden: SystemPresence[] = [];
      let authorized = true;
      let revision = 1;
      const reads: number[] = [];
      const source = { presence };
      let payload: object = source;
      if (publisher === "getter") {
        Object.defineProperty(source, "revision", {
          enumerable: true,
          get: () => {
            authorized = false;
            reads.push(revision);
            return revision;
          },
        });
      } else if (publisher === "toJSON") {
        Object.assign(source, {
          toJSON(key: string) {
            expect(key).toBe("payload");
            reads.push(revision);
            return { presence, revision };
          },
        });
      } else if (publisher === "proxy") {
        payload = new Proxy(source, {
          ownKeys(target) {
            reads.push(revision);
            return Reflect.ownKeys(target);
          },
        });
      }
      peers[0]!.socket.send.mockImplementationOnce(() => {
        revision = 2;
        if (publisher === "added field") {
          Object.assign(source, { revision });
        }
      });
      const { broadcast } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
        preparePresenceProjection: () => () => (authorized ? presence : hidden),
      });
      broadcast("presence", payload);

      for (const [index, peer] of peers.entries()) {
        const expected =
          publisher === "proxy" || (publisher === "added field" && index === 0)
            ? { presence }
            : { presence: publisher === "getter" ? hidden : presence, revision: index + 1 };
        expect(JSON.parse(peer.socket.send.mock.lastCall![0]).payload).toEqual(expected);
      }
      expect(reads).toEqual(publisher === "added field" ? [] : [1, 2]);
    },
  );
});
