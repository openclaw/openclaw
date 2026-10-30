import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withDisposableOpenClawStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "../server-methods/session-change-event.js";
import {
  createGatewayWorkerPlacementChangePublisher,
  subscribeGatewayWorkerPlacementMetadataChanges,
} from "../server-worker-placement-change-events.js";
import { readWorkerPlacementIdentity } from "./placement-projector.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { sessionIdentity } from "./placement-suite.test-support.js";
import {
  advancePlacementFixtureToActive,
  seedAttachedPlacementEnvironment,
} from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./store.js";

const changeContext = (subscribers: string[] = []) => ({
  broadcastToConnIds: vi.fn(),
  getRuntimeConfig: () => ({}),
  getSessionEventSubscriberConnIds: () => new Set(subscribers),
});

it("coalesces machine metadata bursts off thread and selects only correlated profile placements", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
    for (const sessionId of ["pending", "active", "terminal", "stale", "unowned", "other"]) {
      const environmentId = `environment-${sessionId}`;
      seedAttachedPlacementEnvironment(database, {
        environmentId,
        sessionId,
        ownerEpoch: 7,
        profileId: sessionId === "other" ? "other" : "development",
      });
      let placement;
      if (sessionId === "pending" || sessionId === "unowned") {
        const requested = await store.startDispatch(sessionIdentity(sessionId));
        placement = await store.transition({
          sessionId,
          from: "requested",
          to: "provisioning",
          expectedGeneration: requested.generation,
          patch: { environmentId },
        });
      } else {
        placement = await advancePlacementFixtureToActive(
          store,
          database,
          sessionIdentity(sessionId),
          {
            environmentId,
            ownerEpoch: 7,
            seedEnvironment: false,
          },
        );
      }
      if (sessionId === "terminal") {
        placement = await store.transition({
          sessionId,
          from: placement.state,
          expectedGeneration: placement.generation,
          to: "draining",
        });
        await store.startReconcile({
          sessionId,
          environmentId,
          ownerEpoch: 7,
          expectedGeneration: placement.generation,
        });
      }
      if (sessionId === "terminal" || sessionId === "unowned") {
        await store.fail({ sessionId, recoveryError: "synthetic failure" });
      }
      if (sessionId === "stale") {
        seedAttachedPlacementEnvironment(database, { environmentId, sessionId, ownerEpoch: 8 });
      }
    }
    const environments = await createWorkerEnvironmentStore({ database });
    for (const id of ["unowned", "stale"]) {
      expect(
        readWorkerPlacementIdentity(
          store.get(id)!,
          undefined,
          environments.get(`environment-${id}`),
        ),
      ).toBeUndefined();
    }
    const expected = ["active", "pending", "terminal"];
    expect((await store.readChangeSnapshot(["development"])).map((row) => row.sessionId)).toEqual(
      expected,
    );
    expect(await store.readChangeSnapshot([])).toEqual([]);
    expect(await store.readChangeSnapshot(["missing"])).toEqual([]);
    const machineShapeNotifications = { onChanged: (_profileId: string) => {} };
    const received: string[] = [];
    const published = createDeferredCore();
    const unlisten = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change) {
        received.push(change.sessionKey!);
        if (received.length === expected.length) {
          published.resolve();
        }
      }
    });
    const context = changeContext();
    const warn = vi.fn();
    const changes = subscribeGatewayWorkerPlacementMetadataChanges({
      placements: store,
      runnerAvailability: { read: () => undefined, version: () => 0 },
      environments: { machineShapeNotifications },
      getSessionChangeContext: () => context,
      warn,
    });
    requireNodeSqlite();
    const calls = observeMainThreadSql();
    try {
      for (let i = 0; i < 3; i++) {
        machineShapeNotifications.onChanged("development");
      }
      await published.promise;
      await changes.stop();
      machineShapeNotifications.onChanged("development");
      expect(received).toEqual(expected.map((id) => `agent:main:${id}`));
      calls.expectIdle();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await changes.stop();
      vi.restoreAllMocks();
      unlisten();
      await environments.close();
    }
  });
});

it.each(["cached", "fresh"] as const)(
  "reads detached %s placement snapshots off thread and joins the captured source",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(isMainThread).toBe(true);
      const database = openOpenClawStateDatabase();
      const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
      for (const sessionId of ["b", "a"]) {
        await store.startDispatch(sessionIdentity(sessionId));
      }
      const failed = await store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
      const expected = (
        [
          ["a", "failed", 2],
          ["b", "requested", 1],
        ] as const
      ).map(([sessionId, state, generation]) =>
        Object.assign(sessionIdentity(sessionId), { state, generation, updatedAtMs: 1000 }),
      );
      if (mode === "fresh") {
        await closeOpenClawStateDatabaseAsync();
      }
      requireNodeSqlite();
      const calls = observeMainThreadSql();
      let before: Awaited<ReturnType<typeof store.readChangeSnapshot>>;
      try {
        before = await store.readChangeSnapshot();
        expect(before).toEqual(expected);
        calls.expectIdle();
        expect(database.db.isOpen).toBe(mode === "cached");
      } finally {
        vi.restoreAllMocks();
      }
      const mutationStore =
        mode === "fresh" ? createWorkerSessionPlacementStore({ database }) : store;
      await mutationStore.retireSessionPlacementAsync({
        sessionId: "a",
        expectedState: "failed",
        expectedGeneration: failed.generation,
      });
      let after: unknown;
      const laterCalls = observeMainThreadSql();
      try {
        await withDisposableOpenClawStateReads(database.path, async () => {
          void store.readChangeSnapshot().then(
            (rows) => {
              after = rows;
            },
            (error: unknown) => {
              after = error;
            },
          );
        });
        expect(after).toEqual([expected[1]]);
        expect(before).toEqual(expected);
        laterCalls.expectIdle();
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);

it("reports committed changes and cold retirement without reporting reads, including failed operations", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
    await store.startDispatch(sessionIdentity("a"));
    const failed = await store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
    const context = changeContext(["synthetic-client"]);
    const { broadcastToConnIds } = context;
    const eventFor = (sessionId: string) => [
      "sessions.changed",
      expect.objectContaining({ reason: "placement", sessionKey: `agent:main:${sessionId}` }),
      new Set(["synthetic-client"]),
      expect.any(Object),
    ];
    const reportingRead = vi.spyOn(store, "readChangeSnapshot");
    const warn = vi.fn();
    const publisher = (placements = store) =>
      createGatewayWorkerPlacementChangePublisher({
        placements,
        getSessionChangeContext: () => context,
        warn,
      });
    const publishChanges = publisher();
    try {
      await expect(publishChanges(async () => "idle")).resolves.toBe("idle");
      expect(broadcastToConnIds).not.toHaveBeenCalled();
      const otherStore = createWorkerSessionPlacementStore({ database, now: () => 2000 });
      const operationError = new Error("failed after commit");
      await expect(
        publishChanges(async () => {
          await otherStore.startDispatch(sessionIdentity("b"));
          await otherStore.fail({ sessionId: "b", recoveryError: "synthetic failure" });
          throw operationError;
        }),
      ).rejects.toBe(operationError);
      await flushPendingSessionsChangedEvents(context);
      expect(broadcastToConnIds.mock.calls).toEqual([eventFor("b")]);
      broadcastToConnIds.mockClear();
      // Reopening drops the receipt replica: retirement must carry its own identity.
      await closeOpenClawStateDatabaseAsync();
      const reopenedStore = createWorkerSessionPlacementStore({ database });
      const publishRetirement = publisher(reopenedStore);
      await withOpenClawStateDatabaseReadSnapshot(async () => {
        await expect(
          publishRetirement(async () => {
            await reopenedStore.retireSessionPlacementAsync({
              sessionId: "a",
              expectedState: "failed",
              expectedGeneration: failed.generation,
            });
            return "retired";
          }),
        ).resolves.toBe("retired");
        await flushPendingSessionsChangedEvents(context);
        expect(broadcastToConnIds.mock.calls).toContainEqual(eventFor("a"));
      });
      expect((await reopenedStore.listAsync()).map((row) => row.sessionId)).toEqual(["b"]);
      expect(reportingRead).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await flushPendingSessionsChangedEvents(context);
      vi.restoreAllMocks();
    }
  });
});
