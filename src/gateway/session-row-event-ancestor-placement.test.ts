import { afterEach, expect, it, vi } from "vitest";
import { reconcileSessionChanged } from "../../ui/src/lib/sessions/reconcile.ts";
import { sessionsResult } from "../../ui/src/lib/sessions/session-capability.test-support.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
} from "./worker-environments/placement-projector.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

it("keeps cold archived ancestor placement and moves through child-event recipient and UI projection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const profiles = [
      ensureProfileForEmail("owner@ancestor-placement.test"),
      ensureProfileForEmail("viewer@ancestor-placement.test"),
    ];
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    const root = "agent:main:root";
    const gateway = "agent:main:gateway";
    const parent = "agent:main:parent";
    const child = "agent:main:child";
    const creator = { type: "human" as const, source: "profile" as const, id: profiles[0]!.id };
    for (const [key, sessionId, parentSessionKey, visibility, archivedAt] of [
      [gateway, "gateway", undefined, "shared", 1],
      [root, "root", gateway, "shared", 1],
      [parent, "parent", root, "draft", 1],
      [child, "child", parent, "shared", undefined],
      ["agent:main:unused", "unused", undefined, "shared", 1],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId,
          updatedAt: now - 100,
          createdActor: creator,
          parentSessionKey,
          visibility,
          archivedAt,
        },
      );
    }
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database, now: () => now - 50 });
    const rootPlacement = placements.startDispatch({
      sessionId: "root",
      sessionKey: root,
      agentId: "main",
    });
    placements.startDispatch({
      sessionId: "unused",
      sessionKey: "agent:main:unused",
      agentId: "main",
    });
    seedAttachedPlacementEnvironment(database, {
      environmentId: "ancestor-environment",
      sessionId: "parent",
      ownerEpoch: 7,
    });
    let parentPlacement = placements.startDispatch({
      sessionId: "parent",
      sessionKey: parent,
      agentId: "main",
    });
    for (const step of [
      { to: "provisioning", patch: { environmentId: "ancestor-environment" } },
      { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
      {
        to: "starting",
        patch: {
          workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
          remoteWorkspaceDir: "/workspace",
        },
      },
      { to: "active", patch: { activeOwnerEpoch: 7 } },
    ] as const) {
      parentPlacement = placements.transition({
        sessionId: "parent",
        from: parentPlacement.state,
        expectedGeneration: parentPlacement.generation,
        ...step,
      });
    }
    if (parentPlacement.state !== "active") {
      throw new Error("Expected active ancestor fixture");
    }
    const move = placements.beginPlacementMove({
      sessionId: "parent",
      source: {
        generation: parentPlacement.generation,
        environmentId: parentPlacement.environmentId,
        ownerEpoch: parentPlacement.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    const placementReads = vi.spyOn(placements, "readProjection");
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const connection = createGatewayConnectionState({ bootId: "ancestor-placement", cfg });
    const context = requestContext(cfg);
    context.chatAbortControllers = connection.chatAbortControllers;
    context.broadcastToConnIds = connection.broadcastToConnIds;
    bindSessionRowProjection(context, () => projection);
    const detach = connection.attachSessionRowProjection(projection);
    const peers = profiles.map((profile, index) => {
      const send = vi.fn();
      const client = {
        ...sharingPolicyClient({ user: profile.id }),
        connId: `ancestor-${index}`,
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: profile.displayName,
          avatarRevision: "1",
          hasAvatar: false,
          updatedAt: now,
        },
        socket: {
          readyState: 1,
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
      return { client, send };
    });
    context.getSessionEventSubscriberConnIds = () =>
      new Set(peers.map(({ client }) => client.connId));
    try {
      await projection.ensureMaterialized();
      expect(projection.capture({ agentId: "main", key: parent })?.materialized).toBeUndefined();
      expect(projection.capture({ agentId: "main", key: root })?.materialized).toBeUndefined();
      expect(new Set(placementReads.mock.calls.flatMap(([ids]) => ids))).toEqual(
        new Set(["child"]),
      );
      placementReads.mockClear();
      const childQuery = { agentId: "main", key: child };
      const childRow = projection.describe(childQuery)!;
      await projection.withPreparedExactRows(
        () => [childQuery],
        (read) => read.describe(childQuery),
      );
      expect(placementReads).not.toHaveBeenCalled();
      expect(projection.capture({ agentId: "main", key: root })?.materialized).toBeUndefined();
      emitSessionsChanged(
        context,
        { sessionKey: child, agentId: "main", reason: "patch" },
        {
          preparedPublication: true,
        },
      );
      const synchronousFrames = peers.map((peer) => JSON.parse(peer.send.mock.lastCall![0]));
      for (const frame of synchronousFrames) {
        expect(frame.payload.ancestorSessions).toBeUndefined();
      }
      let escapedAncestors: Promise<ReturnType<typeof projection.ancestorRows>> | undefined;
      await projection.withPreparedExactRows(
        () => [childQuery],
        () => {
          escapedAncestors = Promise.resolve().then(() => projection.ancestorRows(childRow));
        },
        { includeAncestors: true },
      );
      expect((await escapedAncestors)?.map((row) => row.key)).toEqual([parent, root, gateway]);
      expect(projection.capture({ agentId: "main", key: parent })?.materialized).toBeDefined();
      expect(projection.capture({ agentId: "main", key: root })?.materialized).toBeDefined();
      expect(new Set(placementReads.mock.calls.flatMap(([ids]) => ids))).toEqual(
        new Set(["root", "parent", "gateway"]),
      );
      placementReads.mockClear();
      sessionChanges.emit({ all: true, scope: "worker-placements" });
      expect(projection.ancestorRows(childRow)).toBeUndefined();
      const rootFields = { placement: projectWorkerSessionPlacement(rootPlacement) };
      const parentFields = {
        placement: projectWorkerSessionPlacement(move.placement),
        placementMove: projectWorkerPlacementMove(move.intent),
      };
      emitSessionsChanged(context, { sessionKey: child, agentId: "main", reason: "patch" });
      await flushPendingSessionsChangedEvents(context);
      for (const [index, peer] of peers.entries()) {
        const frame = JSON.parse(peer.send.mock.lastCall![0]);
        expect(frame.payload.ancestorSessions.map((row: { key: string }) => row.key)).toEqual(
          index === 0 ? [parent, root, gateway] : [root, gateway],
        );
        expect(
          frame.payload.ancestorSessions.find((row: { key: string }) => row.key === gateway)
            .placement,
        ).toBeUndefined();
        const held = sessionsResult(
          [
            { key: child, sessionId: "child", kind: "direct", updatedAt: now - 100 },
            {
              key: gateway,
              sessionId: "gateway",
              kind: "direct",
              updatedAt: now - 100,
              archived: true,
              archivedAt: 1,
            },
            {
              key: root,
              sessionId: "root",
              kind: "direct",
              updatedAt: now - 100,
              archived: true,
              archivedAt: 1,
              ...rootFields,
            },
            ...(index === 0
              ? [
                  {
                    key: parent,
                    sessionId: "parent",
                    kind: "direct" as const,
                    updatedAt: now - 100,
                    archived: true,
                    archivedAt: 1,
                    ...parentFields,
                  },
                ]
              : []),
          ],
          now,
        );
        const synchronous = reconcileSessionChanged(held, synchronousFrames[index].payload, {
          resultAgentId: "main",
          archivedFilter: "all",
        });
        expect(synchronous.result?.sessions.find((row) => row.key === root)?.placement).toEqual(
          rootFields.placement,
        );
        const reconciled = reconcileSessionChanged(held, frame.payload, {
          resultAgentId: "main",
          archivedFilter: "all",
        });
        expect(
          reconciled.result?.sessions.find((row) => row.key === root)?.placement,
        ).toMatchObject(rootFields.placement);
        if (index === 0) {
          const parentRow = reconciled.result?.sessions.find((row) => row.key === parent);
          expect(parentRow?.placement).toMatchObject(parentFields.placement);
          expect(parentRow?.placementMove).toEqual(parentFields.placementMove);
        }
      }
      expect(new Set(placementReads.mock.calls.flatMap(([ids]) => ids))).toEqual(
        new Set(["child", "root", "parent", "gateway"]),
      );
      expect(
        projection.capture({ agentId: "main", key: "agent:main:unused" })?.materialized,
      ).toBeUndefined();
    } finally {
      await flushPendingSessionsChangedEvents(context);
      detach();
      connection.mentionInbox.dispose();
      projection.dispose();
      release();
    }
  });
});
