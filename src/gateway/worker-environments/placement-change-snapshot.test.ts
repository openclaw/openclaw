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
  subscribeGatewayWorkerMachineShapeChanges,
} from "../server-worker-placement-change-events.js";
import { readWorkerPlacementIdentity } from "./placement-projector.js";
import type { WorkerSessionPlacementChangeSnapshot } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./store.js";

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
        placement = store.transition({
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
        placement = store.transition({
          sessionId,
          from: placement.state,
          expectedGeneration: placement.generation,
          to: "draining",
        });
        store.startReconcile({
          sessionId,
          environmentId,
          ownerEpoch: 7,
          expectedGeneration: placement.generation,
        });
      }
      if (sessionId === "terminal" || sessionId === "unowned") {
        store.fail({ sessionId, recoveryError: "synthetic failure" });
      }
      if (sessionId === "stale") {
        seedAttachedPlacementEnvironment(database, { environmentId, sessionId, ownerEpoch: 8 });
      }
    }
    const environments = await createWorkerEnvironmentStore({ database });
    const expected = ["active", "pending", "terminal"];
    expect(
      store
        .list()
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
    const stop = subscribeGatewayWorkerMachineShapeChanges({
      placements: store,
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
      await stop();
      changed("development");
      expect(received).toEqual(expected.map((id) => `agent:main:${id}`));
      calls.expectIdle();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await stop();
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
      const failed = store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
      const warn = vi.fn();
      const publishChanges = createGatewayWorkerPlacementChangePublisher({
        placements: store,
        getSessionChangeContext: () => ({
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          getSessionEventSubscriberConnIds: () => new Set(),
        }),
        warn,
      });
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
        await expect(publishChanges(async () => "reconciled")).resolves.toBe("reconciled");
        expect(warn).not.toHaveBeenCalled();
        calls.expectIdle();
        expect(database.db.isOpen).toBe(mode === "cached");
      } finally {
        vi.restoreAllMocks();
      }
      store.retireSessionPlacement({
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

it("reports committed placement changes inside an inspection snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
    await store.startDispatch({ sessionId: "a", agentId: "main", sessionKey: "agent:main:a" });
    const failed = store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
    const broadcastToConnIds = vi.fn();
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
      await withOpenClawStateDatabaseReadSnapshot(async () => {
        await expect(
          publishChanges(async () => {
            store.retireSessionPlacement({
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
      expect(store.list()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await flushPendingSessionsChangedEvents(context);
    }
  });
});
