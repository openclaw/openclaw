import { expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it("separates equal versions with different contents when reusing recipient encodings", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const profile = ensureProfileForEmail("row-delta-audiences@example.test");
    const key = "agent:main:row-delta-audiences";
    const write = (label: string) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "same-generation", updatedAt: 1, visibility: "shared", label },
      );
    write("Before");
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "row-delta-audiences",
      cfg,
    });
    const detach = connection.attachSessionRowProjection(projection);
    const peers = ["current", "stale", "legacy"].map((id) => {
      const peer = createSessionRowEventPeer(profile, id, 1);
      if (id !== "legacy") {
        peer.client.connect.caps = ["session-row-deltas"];
      }
      connection.clients.add(peer.client);
      connection.sessionEventSubscribers.subscribe(id);
      const decoder = new GatewayChatEvents(() => {
        throw new Error("Unexpected missing row baseline");
      });
      return Object.assign(peer, { decoder });
    });
    const publish = (ids: string[]) =>
      connection.broadcastToConnIds(
        "sessions.changed",
        { sessionKey: key, agentId: "main", reason: "rename" },
        new Set(ids),
      );
    const decodeLast = (peer: (typeof peers)[number]) => {
      const frame = JSON.parse(peer.send.mock.lastCall![0]) as EventFrame;
      let decoded: EventFrame | undefined;
      peer.decoder.dispatch(frame, (event) => {
        decoded = event;
      });
      return decoded?.payload;
    };
    try {
      publish(["stale"]);
      decodeLast(peers[1]!);
      write("After");
      await projection.ensureMaterialized();
      publish(["current"]);
      decodeLast(peers[0]!);
      // Both sockets have version 1; the unchanged recipient is encoded first.
      publish(peers.map((peer) => peer.client.connId));
      const expected = decodeLast(peers[2]!);
      expect(decodeLast(peers[0]!)).toEqual(expected);
      expect(decodeLast(peers[1]!)).toEqual(expected);
      expect(expected).toMatchObject({ session: { label: "After" } });
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});
