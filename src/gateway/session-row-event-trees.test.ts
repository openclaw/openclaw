import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import {
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("publishes fresh ancestor rows through private intermediates with list visibility and no duplicates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const profiles = [
      ensureProfileForEmail("owner@tree-events.test"),
      ensureProfileForEmail("viewer@tree-events.test"),
    ];
    const cfg = {
      ...rolePolicyConfig(),
      agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.4" } } },
    };
    const root = "agent:main:root";
    const parent = "agent:main:parent";
    const child = "agent:main:subagent:child";
    const creator = { type: "human" as const, source: "profile" as const, id: profiles[0]!.id };
    for (const [key, parentSessionKey, visibility] of [
      [root, undefined, "shared"],
      [parent, root, "draft"],
      [child, parent, "shared"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          updatedAt: now - 100,
          createdActor: creator,
          parentSessionKey,
          visibility,
        },
      );
    }
    const connection = createGatewayConnectionState({ bootId: "tree-events", cfg });
    const context = requestContext(cfg);
    context.chatAbortControllers = connection.chatAbortControllers;
    context.broadcastToConnIds = connection.broadcastToConnIds;
    const peers = profiles.map((profile, index) => {
      const send = vi.fn();
      const client = {
        ...sharingPolicyClient({ user: profile.id }),
        connId: `tree-events-${index}`,
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: profile.displayName,
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: now,
        },
        socket: {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send,
          close: vi.fn(),
          terminate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          once: vi.fn(),
        },
      } satisfies GatewayWsClient;
      prepareGatewayRecipientProfile(client);
      connection.clients.add(client);
      connection.sessionMessageSubscribers.subscribe(client.connId, child);
      return { client, send };
    });
    context.getSessionEventSubscriberConnIds = () =>
      new Set(peers.map(({ client }) => client.connId));
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const detach = connection.attachSessionRowProjection(projection);
    try {
      for (const terminal of [false, true]) {
        subagentRuns.set("tree-child", {
          runId: "tree-child",
          childSessionKey: child,
          requesterSessionKey: parent,
          requesterAgentId: "main",
          requesterDisplayKey: parent,
          controllerSessionKey: parent,
          // The collector owner differs from the direct control owner.
          swarmRequesterSessionKey: root,
          task: "synthetic child",
          cleanup: "keep",
          collect: true,
          groupId: "tree-group",
          createdAt: now - 50,
          execution: terminal
            ? { status: "terminal", startedAt: now - 50, endedAt: now - 25 }
            : { status: "running", startedAt: now - 50 },
          completion: { required: false },
          delivery: { status: "not_required" },
          ...(terminal ? { collectorCompletion: { status: "done" } } : {}),
        });
        publishSubagentRunChanges([child]);
        emitSessionsChanged(context, { sessionKey: child, reason: "run-capacity" });
        await flushPendingSessionsChangedEvents(context);
        for (const event of ["sessions.changed", "session.message"]) {
          if (event === "session.message") {
            connection.broadcast(event, { sessionKey: child, agentId: "main", phase: "message" });
          }
          for (const [index, peer] of peers.entries()) {
            const frame = JSON.parse(peer.send.mock.lastCall![0]);
            expect(frame.event).toBe(event);
            const listed = await listSessions({
              client: peer.client,
              context,
              request: {
                includeDerivedTitles: true,
                includeLastMessage: true,
                includeActivitySummary: true,
              },
            });
            const expected = listed.sessions.filter(
              (row) => row.key === parent || row.key === root,
            );
            expect(frame.payload.ancestorSessions).toEqual(expect.arrayContaining(expected));
            expect(frame.payload.ancestorSessions).toHaveLength(index === 0 ? 2 : 1);
            expect(frame.payload.session).toEqual(listed.sessions.find((row) => row.key === child));
            expect(
              frame.payload.ancestorSessions.find((row: { key: string }) => row.key === root).swarm
                .groups[0],
            ).toMatchObject({
              running: terminal ? 0 : 1,
              done: terminal ? 1 : 0,
            });
            if (index === 0) {
              expect(
                frame.payload.ancestorSessions.find((row: { key: string }) => row.key === parent)
                  .childSessions,
              ).toEqual([child]);
            } else {
              expect(
                frame.payload.ancestorSessions.some((row: { key: string }) => row.key === parent),
              ).toBe(false);
            }
          }
        }
      }
      // Corrupt lineage must not amplify one child update or loop indefinitely.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: root },
        {
          sessionId: root,
          updatedAt: now - 100,
          createdActor: creator,
          visibility: "shared",
          parentSessionKey: child,
        },
      );
      emitSessionsChanged(context, { sessionKey: child, reason: "patch" });
      await flushPendingSessionsChangedEvents(context);
      expect(JSON.parse(peers[0]!.send.mock.lastCall![0]).payload.ancestorSessions).toHaveLength(2);

      replaceSessionEntrySync(
        { agentId: "main", sessionKey: root },
        {
          sessionId: root,
          updatedAt: now - 100,
          createdActor: creator,
          visibility: "shared",
          parentSessionKey: "agent:main:missing-intermediary",
        },
      );
      emitSessionsChanged(context, { sessionKey: child, reason: "patch" });
      await flushPendingSessionsChangedEvents(context);
      expect(JSON.parse(peers[0]!.send.mock.lastCall![0]).payload).not.toHaveProperty(
        "ancestorSessions",
      );

      // An oversized chain retains the child snapshot but never certifies a partial bundle.
      const chain = [
        root,
        ...Array.from({ length: 64 }, (_, index) => `agent:main:ancestor-${index}`),
      ];
      for (const [index, key] of chain.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key },
          {
            sessionId: key,
            updatedAt: now - 100,
            createdActor: creator,
            visibility: "shared",
            parentSessionKey: chain[index + 1],
          },
        );
      }
      emitSessionsChanged(context, { sessionKey: child, reason: "patch" });
      await flushPendingSessionsChangedEvents(context);
      for (const peer of peers) {
        const payload = JSON.parse(peer.send.mock.lastCall![0]).payload;
        expect(payload.session.key).toBe(child);
        expect(payload).not.toHaveProperty("ancestorSessions");
      }
    } finally {
      await flushPendingSessionsChangedEvents(context);
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
      subagentRuns.delete("tree-child");
    }
  });
});
