import { expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { ConnectionSessionRows } from "./session-ancestor-references.js";
import { createSessionRowDeltaDiffer } from "./session-row-delta-fields.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

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
        const delivery = peer.rows.prepareRows([row], diff);
        return {
          payload: {
            session: delivery.wire[0],
            ...(brokenSerialization && peer === peers[0] ? { invalid: 1n } : {}),
          },
          delivered: delivery.delivered,
        };
      },
    });
    try {
      broadcast("sessions.changed", {});
      expect(peers[0]!.rows.prepareRows([row], diff).wire[0]).toHaveProperty("base");
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
      expect(peers[0]!.rows.prepareRows([row], diff).wire[0]).toHaveProperty("full");
      expect(peers[1]!.rows.prepareRows([row], diff).wire[0]).toHaveProperty("base");
    } finally {
      peers.forEach((peer) => peer.rows.clear());
      vi.restoreAllMocks();
    }
  },
);
