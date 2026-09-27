import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { SessionAncestorRef } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntrySync,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
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
import type { GatewaySessionRow } from "./session-utils.types.js";

type TreeEventPayload = {
  session: GatewaySessionRow;
  ancestorSessions?: GatewaySessionRow[];
  ancestorSessionRefs?: SessionAncestorRef[];
};

afterEach(() => vi.restoreAllMocks());

it("publishes fresh ancestor rows through private intermediates with list visibility and no duplicates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const profiles = [
      ensureProfileForEmail("owner@tree-events.test"),
      ensureProfileForEmail("viewer@tree-events.test"),
    ];
    const policy = rolePolicyConfig();
    // The presentation-only toggles below need scopes admitted by the current role.
    policy.gateway!.roles!.definitions.view!.scopes.push("operator.admin");
    const cfg = {
      ...policy,
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
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "tree-events",
      cfg,
    });
    const context = requestContext(cfg);
    context.chatAbortControllers = connection.chatAbortControllers;
    context.broadcastToConnIds = connection.broadcastToConnIds;
    const createPeer = (profile: (typeof profiles)[number], connId: string) => {
      const send = vi.fn();
      const client = {
        ...sharingPolicyClient({ user: profile.id }),
        connId,
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
      connection.sessionEventSubscribers.subscribe(client.connId);
      connection.sessionMessageSubscribers.subscribe(client.connId, child);
      return { client, send, ancestors: new Map<string, GatewaySessionRow>() };
    };
    const peers = profiles.map((profile, index) => createPeer(profile, `tree-events-${index}`));
    context.getSessionEventSubscriberConnIds = connection.sessionEventSubscribers.getAll;
    await initializeSessionReadContext(context);
    const projection = getSessionRowProjection(context)!;
    const detach = connection.attachSessionRowProjection(projection);
    const payloadFor = (peer: (typeof peers)[number]): TreeEventPayload =>
      JSON.parse(peer.send.mock.lastCall![0]).payload;
    const assertListParity = async (peer: (typeof peers)[number]) => {
      const payload = payloadFor(peer);
      const ancestors = [...(payload.ancestorSessions ?? [])];
      for (const row of ancestors) {
        expect(row.ancestorRevision).toEqual(expect.any(String));
        peer.ancestors.set(row.key, row);
      }
      for (const ref of payload.ancestorSessionRefs ?? []) {
        const held = peer.ancestors.get(ref.key);
        expect(held).toMatchObject({
          ancestorRevision: ref.revision,
          sessionId: ref.sessionId,
          agentId: ref.agentId,
        });
        const row = { ...held!, snapshotAt: ref.snapshotAt };
        peer.ancestors.set(ref.key, row);
        ancestors.push(row);
      }
      const listed = await listSessions({
        client: peer.client,
        context,
        request: {
          includeDerivedTitles: true,
          includeLastMessage: true,
          includeActivitySummary: true,
        },
      });
      const expected = listed.sessions.filter((row) => row.key === parent || row.key === root);
      const actual = ancestors.map(({ ancestorRevision: _revision, ...row }) => row);
      expect(
        actual.map((row) => row.key).toSorted(),
        `ancestor coverage for ${peer.client.connId} with ${peer.client.connect.scopes?.join(",")}`,
      ).toEqual(expected.map((row) => row.key).toSorted());
      expect(actual).toEqual(expect.arrayContaining(expected));
      expect(payload.session).toEqual(listed.sessions.find((row) => row.key === child));
      return actual;
    };
    const publishChild = async () => {
      emitSessionsChanged(context, { sessionKey: child, reason: "patch" });
      await flushPendingSessionsChangedEvents(context);
    };
    const expectFull = (peer: (typeof peers)[number], keys: string[]) => {
      expect(payloadFor(peer).ancestorSessions?.map((row) => row.key)).toEqual(keys);
      expect(payloadFor(peer)).not.toHaveProperty("ancestorSessionRefs");
    };
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
        for (const [eventIndex, event] of [
          "sessions.changed",
          "session.message",
          "sessions.changed",
        ].entries()) {
          if (event === "session.message") {
            now += 1;
            connection.broadcast(event, { sessionKey: child, agentId: "main", phase: "message" });
          } else if (eventIndex > 0) {
            await publishChild();
          }
          for (const [index, peer] of peers.entries()) {
            const frame = JSON.parse(peer.send.mock.lastCall![0]);
            expect(frame.event).toBe(event);
            const ancestors = await assertListParity(peer);
            if (eventIndex === 0) {
              expectFull(peer, index === 0 ? [parent, root] : [root]);
            } else {
              expect(frame.payload.ancestorSessions).toEqual([]);
              expect(frame.payload.ancestorSessionRefs).toHaveLength(index === 0 ? 2 : 1);
            }
            expect(ancestors.find((row) => row.key === root)?.swarm?.groups[0]).toMatchObject({
              running: terminal ? 0 : 1,
              done: terminal ? 1 : 0,
            });
            if (index === 0) {
              expect(ancestors.find((row) => row.key === parent)?.childSessions).toEqual([child]);
            } else {
              expect(ancestors.some((row) => row.key === parent)).toBe(false);
            }
          }
        }
      }
      for (const subscriptions of ["roster", "messages"] as const) {
        const owner = peers[0]!;
        if (subscriptions === "roster") {
          connection.sessionEventSubscribers.unsubscribe(owner.client.connId);
          connection.sessionEventSubscribers.subscribe(owner.client.connId);
        } else {
          connection.sessionMessageSubscribers.unsubscribe(owner.client.connId, child);
          connection.sessionMessageSubscribers.subscribe(owner.client.connId, child);
        }
        await publishChild();
        expectFull(owner, [parent, root]);
        expect(payloadFor(peers[1]!).ancestorSessions).toEqual([]);
        await assertListParity(owner);
      }

      const viewer = peers[1]!;
      const viewerScopes = viewer.client.connect.scopes;
      for (const admin of [true, false, true, false]) {
        const previousParentRevision = viewer.ancestors.get(parent)?.ancestorRevision;
        viewer.client.connect.scopes = admin ? ["operator.admin"] : viewerScopes;
        const previousFrames = viewer.send.mock.calls.length;
        connection.broadcast("session.message", {
          sessionKey: child,
          agentId: "main",
          phase: "message",
        });
        expect(viewer.send).toHaveBeenCalledTimes(previousFrames + 1);
        const ancestors = await assertListParity(viewer);
        if (admin) {
          const fullParent = payloadFor(viewer).ancestorSessions?.find((row) => row.key === parent);
          expect(fullParent).toBeDefined();
          expect(fullParent?.ancestorRevision).not.toBe(previousParentRevision);
        } else {
          expect(ancestors.some((row) => row.key === parent)).toBe(false);
        }
      }

      const returning = peers[0]!;
      connection.clients.delete(returning.client);
      connection.clients.add(returning.client);
      await publishChild();
      expectFull(returning, [parent, root]);
      expect(payloadFor(peers[1]!).ancestorSessions).toEqual([]);
      await assertListParity(returning);

      const retired = peers[0]!;
      connection.sessionEventSubscribers.unsubscribe(retired.client.connId);
      connection.sessionMessageSubscribers.unsubscribeAll(retired.client.connId);
      connection.clients.delete(retired.client);
      peers[0] = createPeer(profiles[0]!, retired.client.connId);
      await publishChild();
      expectFull(peers[0]!, [parent, root]);
      expect(payloadFor(peers[1]!).ancestorSessions).toEqual([]);
      await assertListParity(peers[0]!);

      const newcomer = createPeer(profiles[0]!, "tree-events-newcomer");
      await publishChild();
      expectFull(newcomer, [parent, root]);
      expect(payloadFor(peers[0]!).ancestorSessions).toEqual([]);
      await assertListParity(newcomer);
      connection.sessionEventSubscribers.unsubscribe(newcomer.client.connId);
      connection.sessionMessageSubscribers.unsubscribeAll(newcomer.client.connId);
      connection.clients.delete(newcomer.client);

      const rootScope = { agentId: "main", sessionKey: root };
      for (const visibility of ["draft", "shared"] as const) {
        replaceSessionEntrySync(rootScope, { ...loadSessionEntry(rootScope)!, visibility });
        await publishChild();
        expect(payloadFor(peers[0]!).ancestorSessions?.map((row) => row.key)).toContain(root);
        expectFull(peers[1]!, visibility === "draft" ? [] : [root]);
        for (const peer of peers) {
          await assertListParity(peer);
        }
      }

      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      const target = { canonicalKey: root, storeKeys: [root] };
      await resetSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target,
        archivePreviousTranscript: false,
        buildNextEntry: ({ currentEntry }) => ({
          ...currentEntry!,
          lifecycleRevision: "reset-root",
        }),
      });
      expect(loadSessionEntry(rootScope)?.lifecycleRevision).toBe("reset-root");
      await publishChild();
      for (const peer of peers) {
        const fullRoot = payloadFor(peer).ancestorSessions?.find((row) => row.key === root);
        expect(fullRoot).toBeDefined();
        expect(fullRoot?.ancestorRevision).not.toBe(peer.ancestors.get(root)?.ancestorRevision);
        await assertListParity(peer);
      }
      const rootBeforeDelete = loadSessionEntry(rootScope)!;
      const revisionBeforeDelete = peers[0]!.ancestors.get(root)!.ancestorRevision;
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target,
        archiveTranscript: false,
      });
      // Recreate identical presentation before the next event; deletion must retire its receipt.
      replaceSessionEntrySync(rootScope, rootBeforeDelete);
      await publishChild();
      for (const peer of peers) {
        expect(payloadFor(peer).ancestorSessions?.map((row) => row.key)).toContain(root);
        await assertListParity(peer);
      }
      expect(peers[0]!.ancestors.get(root)!.ancestorRevision).not.toBe(revisionBeforeDelete);

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
      const cyclicPayload = payloadFor(peers[0]!);
      expect(
        [
          ...(cyclicPayload.ancestorSessions ?? []),
          ...(cyclicPayload.ancestorSessionRefs ?? []),
        ].map((row) => row.key),
      ).toEqual(expect.arrayContaining([root, parent]));
      await assertListParity(peers[0]!);

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
      expect(payloadFor(peers[0]!)).not.toHaveProperty("ancestorSessionRefs");

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
        expect(payload).not.toHaveProperty("ancestorSessionRefs");
      }
    } finally {
      await flushPendingSessionsChangedEvents(context);
      detach();
      connection.mentionInbox.dispose();
      projection.dispose();
      subagentRuns.delete("tree-child");
    }
  });
});
