import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePublisher } from "./server-chat-lifecycle-publication.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";
import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
} from "./worker-environments/placement-projector.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

afterEach(() => vi.restoreAllMocks());

it("publishes cold archived ancestor placement and moves only to authorized child-event recipients", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const profiles = [
      ensureProfileForEmail("owner@ancestor-placement.test"),
      ensureProfileForEmail("viewer@ancestor-placement.test"),
    ];
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const root = "agent:main:root";
    const gateway = "agent:main:gateway";
    const parent = "agent:main:parent";
    const child = "agent:main:child";
    const query = (key: string) => ({ agentId: "main", key });
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
    const dispatch = (sessionId: string) =>
      placements.startDispatch({
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        agentId: "main",
      });
    const rootPlacement = await dispatch("root");
    await dispatch("unused");
    seedAttachedPlacementEnvironment(database, {
      environmentId: "ancestor-environment",
      sessionId: "parent",
      ownerEpoch: 7,
    });
    let parentPlacement = await dispatch("parent");
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
      parentPlacement = await placements.transition({
        sessionId: "parent",
        from: parentPlacement.state,
        expectedGeneration: parentPlacement.generation,
        ...step,
      });
    }
    if (parentPlacement.state !== "active") {
      throw new Error("Expected active ancestor fixture");
    }
    const move = await placements.beginPlacementMove({
      sessionId: "parent",
      source: {
        generation: parentPlacement.generation,
        environmentId: parentPlacement.environmentId,
        ownerEpoch: parentPlacement.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "ancestor-placement",
      cfg,
    });
    const context = requestContext(cfg);
    context.broadcastToConnIds = connection.broadcastToConnIds;
    bindSessionRowProjection(context, () => projection);
    const detach = connection.attachSessionRowProjection(projection);
    const peers = profiles.map((profile, index) => {
      const { client, send } = createSessionRowEventPeer(profile, `ancestor-${index}`, now);
      connection.clients.add(client);
      return { client, send };
    });
    context.getSessionEventSubscriberConnIds = () =>
      new Set(peers.map(({ client }) => client.connId));
    const materialized = (key: string) => projection.capture(query(key))?.materialized;
    try {
      await projection.ensureMaterialized();
      expect(materialized(parent)).toBeUndefined();
      expect(materialized(root)).toBeUndefined();
      const childQuery = query(child);
      const childRow = projection.describe(childQuery)!;
      await projection.withPreparedExactRows(
        () => [childQuery],
        (read) => read.describe(childQuery),
      );
      expect(materialized(root)).toBeUndefined();
      emitSessionsChanged(
        context,
        { sessionKey: child, agentId: "main", reason: "patch" },
        { preparedPublication: true },
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
      expect(materialized(parent)).toBeDefined();
      expect(materialized(root)).toBeDefined();
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
        expect(
          frame.payload.ancestorSessions.find((row: { key: string }) => row.key === root),
        ).toMatchObject(rootFields);
        if (index === 0) {
          const parentRow = frame.payload.ancestorSessions.find(
            (row: { key: string }) => row.key === parent,
          );
          expect(parentRow).toMatchObject({ placement: parentFields.placement });
          expect(parentRow?.placementMove).toEqual(parentFields.placementMove);
        }
      }
      expect(materialized("agent:main:unused")).toBeUndefined();
      const ancestors = vi.spyOn(projection, "ancestorRows");
      for (const phase of ["start", "model", "end", "error"] as const) {
        ancestors.mockClear();
        for (const peer of peers) {
          connection.forgetConnectionAncestors(peer.client.connId);
          connection.sessionEventSubscribers.subscribe(peer.client.connId);
        }
        const persistence = Promise.resolve();
        const publisher = createSessionLifecyclePublisher({
          getSessionRowProjection: () => projection,
          sessionEventSubscribers: connection.sessionEventSubscribers,
          persistGatewaySessionLifecycleEventForEvent: async () => {},
          loadGatewaySessionLifecycleSnapshotForEvent: (key, options) => {
            const row = options?.sessionRows?.describe(query(key));
            return { row: row ? options!.sessionRows!.present(row) : null };
          },
          broadcastToConnIds: connection.broadcastToConnIds,
        });
        const publication = {
          sessionKey: child,
          agentId: "main",
          clientRunId: "ancestor-lifecycle",
          event: {
            runId: "ancestor-lifecycle",
            stream: "lifecycle",
            seq: 1,
            ts: now,
            data: { phase },
          },
        };
        publisher.publish(
          phase === "start" || phase === "model"
            ? { ...publication, phase, runContext: undefined }
            : { ...publication, phase, persistence, projection },
        );
        await persistence;
        await drainSessionEventPublications(projection);
        expect(ancestors, phase).toHaveBeenCalledOnce();
        for (const [index, peer] of peers.entries()) {
          const frame = JSON.parse(peer.send.mock.lastCall![0]);
          expect(frame.payload.phase).toBe(phase);
          expect(frame.payload.ancestorSessions.map((row: { key: string }) => row.key)).toEqual(
            index === 0 ? [parent, root, gateway] : [root, gateway],
          );
        }
      }
    } finally {
      await flushPendingSessionsChangedEvents(context);
      detach();
      await connection.mentionInbox.dispose();
      projection.dispose();
      release();
    }
  });
});
