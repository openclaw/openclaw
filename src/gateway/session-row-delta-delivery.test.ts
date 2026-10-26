import { expect, it, vi } from "vitest";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { ConnectionSessionRows } from "./session-ancestor-references.js";
import { createSessionRowDeltaDiffer } from "./session-row-delta-fields.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

it("prepares unchanged frozen fields once across row revisions and delivery histories", () => {
  const owners = Array.from({ length: 3 }, () => new ConnectionSessionRows());
  const first = freezeTrustedJsonSnapshot({ text: "unchanged".repeat(100), timestamp: 1 });
  const replacement = freezeTrustedJsonSnapshot({ text: "replacement".repeat(100), timestamp: 2 });
  const stringify = JSON.stringify;
  const encodings = new Map<object, number>();
  const encoding = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
    const value: unknown = args[0];
    if (value === first || value === replacement) {
      encodings.set(value, (encodings.get(value) ?? 0) + 1);
    }
    return stringify(...args);
  });
  try {
    for (let event = 0; event < 12; event++) {
      const lastAssistantMessage = event < 6 ? first : replacement;
      const row: GatewaySessionRow = Object.freeze({
        key: "agent:main:stream",
        agentId: "main",
        sessionId: "stream",
        kind: "direct",
        updatedAt: 1,
        runtimeMs: event,
        lastAssistantMessage,
      });
      const diff = createSessionRowDeltaDiffer();
      for (const [index, owner] of owners.entries()) {
        // A delayed recipient must still receive the replacement from its own baseline.
        if (index === 1 && event === 6) {
          continue;
        }
        const delivery = owner.prepareDelivery(
          row,
          undefined,
          "00000000-0000-4000-8000-000000000001",
          diff,
        );
        if (event > 0) {
          const set = {
            runtimeMs: event,
            ...(event === 6 || (index === 1 && event === 7) ? { lastAssistantMessage } : {}),
          };
          expect(delivery.rows?.wire[0]).toMatchObject({ set, remove: [] });
          expect(JSON.parse(delivery.rows!.encoded[0]!).set).toEqual(set);
        }
        owner.deliver(delivery);
      }
    }
    expect([...encodings.values()]).toEqual([1, 1]);
  } finally {
    encoding.mockRestore();
    owners.forEach((owner) => owner.clear());
  }
});

it.each(["drop", "throw", "callback", "serialize"] as const)(
  "%s invalidates a connection's vectors without touching another recipient",
  (failure) => {
    const peers = ["slow", "healthy"].map((key) =>
      Object.assign(createSessionRowEventPeer({ id: key, displayName: key }, key, 1), {
        rows: new ConnectionSessionRows(),
      }),
    );
    const row: GatewaySessionRow = Object.freeze({
      key: "agent:main:delivery",
      agentId: "main",
      sessionId: "delivery",
      kind: "direct",
      updatedAt: 1,
      label: "full".repeat(500),
    });
    const diff = createSessionRowDeltaDiffer();
    let brokenSerialization = false;
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map((peer) => peer.client)),
      onSessionDeliveryLost: (client) => peers.find((peer) => peer.client === client)?.rows.clear(),
      prepareSessionEventProjection: () => (client) => {
        const peer = peers.find((entry) => entry.client === client);
        if (!peer) {
          throw new Error("Unknown recipient");
        }
        const delivery = peer.rows.prepareDelivery(row, undefined, undefined, diff);
        return {
          payload: {
            session: delivery.rows?.wire[0],
            ...(brokenSerialization && peer === peers[0] ? { invalid: 1n } : {}),
          },
          delivered: () => peer.rows.deliver(delivery),
        };
      },
    });
    try {
      broadcast("sessions.changed", {});
      expect(
        peers[0]!.rows.prepareDelivery(row, undefined, undefined, diff).rows?.wire[0],
      ).toHaveProperty("base");
      if (failure === "drop") {
        peers[0]!.client.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      } else if (failure === "serialize") {
        brokenSerialization = true;
      } else if (failure === "throw") {
        peers[0]!.send.mockImplementationOnce(() => {
          throw new Error("closed");
        });
      } else {
        peers[0]!.send.mockImplementationOnce((_frame, _options, done: (error?: Error) => void) =>
          done(new Error("closed")),
        );
      }
      broadcast("sessions.changed", {}, { dropIfSlow: true });
      expect(
        peers[0]!.rows.prepareDelivery(row, undefined, undefined, diff).rows?.wire[0],
      ).toHaveProperty("full");
      expect(
        peers[1]!.rows.prepareDelivery(row, undefined, undefined, diff).rows?.wire[0],
      ).toHaveProperty("base");
    } finally {
      peers.forEach((peer) => peer.rows.clear());
      vi.restoreAllMocks();
    }
  },
);
