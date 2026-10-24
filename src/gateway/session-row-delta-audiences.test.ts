import { expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { GatewayChatEvents } from "../../ui/src/api/gateway-chat-events.ts";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { SessionsListResult } from "./session-utils.types.js";

it("preserves shared ancestor references across staggered roster reads and first admission", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const profile = ensureProfileForEmail("row-delta-polling@example.test");
    const parent = "agent:main:parent";
    const child = "agent:main:child";
    for (const [key, label, updatedAt, parentSessionKey] of [
      [parent, "Parent", 1, undefined],
      [child, "Child", 2, parent],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: key, label, updatedAt, visibility: "shared", parentSessionKey },
      );
    }
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "row-delta-polling",
      cfg,
    });
    const context = requestContext(cfg);
    context.forgetConnectionAncestors = connection.forgetConnectionAncestors;
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const detach = connection.attachSessionRowProjection(projection);
    const peers = Array.from({ length: 4 }, (_, index) => {
      const peer = createSessionRowEventPeer(profile, `polling-${index}`, 1);
      peer.client.connect.caps = ["session-row-deltas"];
      if (index >= 2) {
        peer.client.connect.caps.push("session-event-field-refs");
      }
      connection.clients.add(peer.client);
      connection.sessionEventSubscribers.subscribe(peer.client.connId);
      const decoder = new GatewayChatEvents(() => {
        throw new Error("Unexpected missing row baseline");
      });
      return Object.assign(peer, { decoder });
    });
    const publish = () =>
      connection.broadcastToConnIds(
        "sessions.changed",
        { sessionKey: child, agentId: "main", reason: "send" },
        new Set(peers.map((peer) => peer.client.connId)),
      );
    const frameFor = (peer: (typeof peers)[number]) =>
      JSON.parse(peer.send.mock.lastCall![0]) as EventFrame;
    try {
      publish();
      // The socket admits this row before a roster listener or its first list exists.
      for (const peer of peers) {
        peer.decoder.dispatch(frameFor(peer));
      }
      publish();
      const initial = frameFor(peers[0]!).payload as {
        ancestorSessionRefs: Array<{ revision: string }>;
      };
      const revision = initial.ancestorSessionRefs[0]!.revision;
      for (const peer of peers) {
        peer.decoder.dispatch(frameFor(peer));
      }
      for (const reader of [...peers, peers[0]!]) {
        const result = await reader.decoder.request<SessionsListResult>(
          {
            request: async <T>() =>
              (await listSessions({
                client: reader.client,
                context,
                request: { agentId: "main", limit: 1 },
              })) as T,
          },
          "sessions.list",
          { agentId: "main", limit: 1 },
        );
        expect(result.sessions.map((row) => row.key)).toEqual([child]);
        publish();
        for (const peer of peers) {
          const frame = frameFor(peer);
          expect(frame.payload).toMatchObject({
            ancestorSessions: [],
            ancestorSessionRefs: [{ key: parent, revision }],
          });
          let decoded: EventFrame | undefined;
          peer.decoder.dispatch(frame, (event) => {
            decoded = event;
          });
          expect(decoded?.payload).toMatchObject({
            session: { key: child, label: "Child" },
            ancestorSessions: [{ key: parent, sessionId: parent, label: "Parent" }],
          });
          expect(decoded?.payload).not.toHaveProperty("ancestorSessionRefs");
        }
      }
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});

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
    const peers = ["current", "stale", "current-refs", "stale-refs", "legacy"].map((id) => {
      const peer = createSessionRowEventPeer(profile, id, 1);
      if (id !== "legacy") {
        peer.client.connect.caps = ["session-row-deltas"];
        if (id.endsWith("-refs")) {
          peer.client.connect.caps.push("session-event-field-refs");
        }
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
      publish(["stale", "stale-refs"]);
      decodeLast(peers[1]!);
      decodeLast(peers[3]!);
      write("After");
      await projection.ensureMaterialized();
      publish(["current", "current-refs"]);
      decodeLast(peers[0]!);
      decodeLast(peers[2]!);
      // Both sockets have version 1; the unchanged recipient is encoded first.
      publish(peers.map((peer) => peer.client.connId));
      const expected = decodeLast(peers[4]!);
      for (const peer of peers.slice(0, -1)) {
        expect(decodeLast(peer)).toEqual(expected);
        const payload = JSON.parse(peer.send.mock.lastCall![0]).payload;
        if (peer.client.connId.endsWith("-refs")) {
          expect(payload.sessionFieldRefs).toEqual(expect.any(Array));
          expect(payload).not.toHaveProperty("label");
        } else {
          expect(payload).not.toHaveProperty("sessionFieldRefs");
          expect(payload).toHaveProperty("label", "After");
        }
      }
      expect(expected).toMatchObject({ session: { label: "After" } });
    } finally {
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
    }
  });
});
