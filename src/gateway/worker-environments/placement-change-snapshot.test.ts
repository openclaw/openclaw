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
import {
  placementTurnOwner,
  type WorkerSessionPlacementChangeSnapshot,
} from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  seedAttachedPlacementEnvironment,
} from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./store.js";

for (const state of ["active", "draining"] as const) {
  it(`publishes a public placement change after the ${state} workspace result settles`, async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawStateDatabase();
      const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
      const identity = {
        sessionId: "workspace-settlement",
        sessionKey: "agent:main:workspace-settlement",
        agentId: "main",
      };
      const active = await advancePlacementFixtureToActive(store, database, identity);
      const claim = await store.claimTurn({
        ...identity,
        owner: placementTurnOwner(active),
        claimId: "settled-claim",
        runId: "settled-run",
      });
      await store.markWorkspaceResultPending(claim);
      if (state === "draining") {
        await store.startWorkspaceResultDrain(claim);
      }
      expect(
        (await store.readProjection([identity.sessionId])).workspaceResultReconcilingSessionIds,
      ).toEqual(new Set([identity.sessionId]));
      const published = createDeferredCore();
      const abort = () => published.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const broadcastToConnIds = vi.fn(() => published.resolve());
      const context = {
        broadcastToConnIds,
        chatAbortControllers: new Map(),
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set(["synthetic-client"]),
      };
      const warn = vi.fn();
      const changes = subscribeGatewayWorkerPlacementMetadataChanges({
        placements: store,
        runnerAvailability: { read: () => undefined, version: () => 0 },
        environments: { subscribeMachineShapeChanged: () => () => {} },
        getSessionChangeContext: () => context,
        warn,
      });
      try {
        await store.acceptWorkspaceResult(claim);
        await store.completeWorkspaceResultAndReleaseTurn(claim);
        const settled = await store.readProjection([identity.sessionId]);
        expect(settled.workspaceResultReconcilingSessionIds.size).toBe(0);
        expect(settled.placements.get(identity.sessionId)?.turnClaim).toBeNull();
        await published.promise;
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "placement", ...identity }),
          new Set(["synthetic-client"]),
          expect.any(Object),
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        signal.removeEventListener("abort", abort);
        await changes.stop();
        await flushPendingSessionsChangedEvents(context);
      }
    });
  });
}

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
      let placement = await store.startDispatch({
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        agentId: "main",
      });
      for (const step of [
        { to: "provisioning", patch: { environmentId } },
        { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
        {
          to: "starting",
          patch: { workspaceBaseManifestRef: "manifest", remoteWorkspaceDir: "/workspace" },
        },
        { to: "active", patch: { activeOwnerEpoch: 7 } },
      ] as const) {
        placement = await store.transition({
          sessionId,
          from: placement.state,
          expectedGeneration: placement.generation,
          ...step,
        });
        if (sessionId === "pending" || sessionId === "unowned") {
          break;
        }
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
    const expected = ["active", "pending", "terminal"];
    expect(
      (await store.listAsync())
        .filter(
          (row) =>
            readWorkerPlacementIdentity(
              row,
              undefined,
              row.environmentId ? (environments.get(row.environmentId) ?? null) : null,
            )?.profileId === "development",
        )
        .map((row) => row.sessionId),
    ).toEqual(expected);
    expect((await store.readChangeSnapshot(["development"])).map((row) => row.sessionId)).toEqual(
      expected,
    );
    expect(await store.readChangeSnapshot([])).toEqual([]);
    expect(await store.readChangeSnapshot(["missing"])).toEqual([]);
    let changed!: (profileId: string) => void;
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
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    };
    const warn = vi.fn();
    const changes = subscribeGatewayWorkerPlacementMetadataChanges({
      placements: store,
      runnerAvailability: { read: () => undefined, version: () => 0 },
      environments: {
        subscribeMachineShapeChanged: (listener) => {
          changed = listener;
          return () => {};
        },
      },
      getSessionChangeContext: () => context,
      warn,
    });
    requireNodeSqlite();
    const calls = observeMainThreadSql();
    try {
      for (let i = 0; i < 3; i++) {
        changed("development");
      }
      await published.promise;
      await changes.stop();
      changed("development");
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
        await store.startDispatch({
          sessionId,
          agentId: "main",
          sessionKey: `agent:main:${sessionId}`,
        });
      }
      const failed = await store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
      const expected: WorkerSessionPlacementChangeSnapshot[] = [
        {
          sessionId: "a",
          sessionKey: "agent:main:a",
          agentId: "main",
          state: "failed",
          generation: 2,
          updatedAtMs: 1000,
        },
        {
          sessionId: "b",
          sessionKey: "agent:main:b",
          agentId: "main",
          state: "requested",
          generation: 1,
          updatedAtMs: 1000,
        },
      ];
      if (mode === "fresh") {
        await closeOpenClawStateDatabaseAsync();
      }
      requireNodeSqlite();
      const calls = observeMainThreadSql();
      let before: WorkerSessionPlacementChangeSnapshot[];
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
    await store.startDispatch({ sessionId: "a", agentId: "main", sessionKey: "agent:main:a" });
    const failed = await store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
    const broadcastToConnIds = vi.fn();
    const reportingRead = vi.spyOn(store, "readChangeSnapshot");
    const warn = vi.fn();
    const context = {
      broadcastToConnIds,
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set(["synthetic-client"]),
    };
    const publishChanges = createGatewayWorkerPlacementChangePublisher({
      placements: store,
      getSessionChangeContext: () => context,
      warn,
    });
    try {
      await expect(publishChanges(async () => "idle")).resolves.toBe("idle");
      expect(broadcastToConnIds).not.toHaveBeenCalled();
      const otherStore = createWorkerSessionPlacementStore({ database, now: () => 2000 });
      const operationError = new Error("failed after commit");
      await expect(
        publishChanges(async () => {
          await otherStore.startDispatch({
            sessionId: "b",
            agentId: "main",
            sessionKey: "agent:main:b",
          });
          await otherStore.fail({ sessionId: "b", recoveryError: "synthetic failure" });
          throw operationError;
        }),
      ).rejects.toBe(operationError);
      await flushPendingSessionsChangedEvents(context);
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        expect.objectContaining({ reason: "placement", sessionKey: "agent:main:b" }),
        new Set(["synthetic-client"]),
        expect.any(Object),
      );
      broadcastToConnIds.mockClear();
      // Reopening drops the receipt replica: retirement must carry its own identity.
      await closeOpenClawStateDatabaseAsync();
      const reopenedStore = createWorkerSessionPlacementStore({ database });
      const publishRetirement = createGatewayWorkerPlacementChangePublisher({
        placements: reopenedStore,
        getSessionChangeContext: () => context,
        warn,
      });
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
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "placement", sessionKey: "agent:main:a" }),
          new Set(["synthetic-client"]),
          expect.any(Object),
        );
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
