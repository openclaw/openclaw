import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { result as spawnResult } from "./bootstrap.test-support.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./placement-disk-space.js";
import {
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "./placement-projector.js";
import { placementTurnOwner, type WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  placementClaim,
  placementSource,
  placementTransition,
  sessionIdentity,
} from "./placement-suite.test-support.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./placement-test-fixtures.js";
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";
import { matchesWorkspaceResultClaim } from "./placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { prepareSessionWorkerPlacementMutationCheckAsync } from "./session-placement-lifecycle.js";
import { createWorkerEnvironmentStore } from "./store.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  }),
);

let database: OpenClawStateDatabase;
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-projection-"));
  database = openOpenClawStateDatabase();
});

function insertFixtureRow(
  db: OpenClawStateDatabase["db"],
  table: string,
  values: Record<string, SQLInputValue>,
) {
  const columns = Object.keys(values).map((key) =>
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  );
  db.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...Object.values(values));
}

function retentionTransport(
  node: ReturnType<typeof createNodeWorkerBundleTestNode>,
  invoke: NodeWorkerSupervisorTransport["invoke"],
) {
  return {
    getCurrentNode: async () => node,
    listCurrentNodes: async () => [node],
    hasCurrentRunner: () => true,
    isCurrent: () => true,
    invoke,
  };
}

async function activePlacement(
  sessionId: string,
  executionMode: WorkerPlacementExecutionMode = "worker-turn",
) {
  const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const identity = sessionIdentity(sessionId);
  const environmentId = `environment-${sessionId}`;
  const placement = await advancePlacementFixtureToActive(
    store,
    database,
    { ...identity, executionMode },
    {
      environmentId,
      remoteWorkspaceDir: "/workspace",
      seedEnvironment: "before-dispatch",
    },
  );
  return { store, placement, identity };
}

it("publishes retention after its scheduler callback finishes", async () => {
  const placements = createWorkerSessionPlacementStore({ database });
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  const node = createNodeWorkerBundleTestNode();
  node.workerHost.bundleRetention = 1;
  const build = { bundleHash: "b".repeat(64), openclawVersion: "2026.10.10" };
  const preparing = createDeferred();
  const prepared = createDeferred<typeof build>();
  let holdPreparation = false;
  const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
    ok: true,
    payloadJSON: JSON.stringify({ applied: true, deleted: 0, hasMore: false }),
  }));
  const warn = vi.fn();
  const coordinator = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: "gateway-retention",
    placements,
    environments: { list: () => [] },
    warn,
    bundleRetention: {
      currentBuild: async () => {
        if (holdPreparation) {
          preparing.resolve();
          return await prepared.promise;
        }
        return build;
      },
      isEnvironmentOwnedNode: () => false,
    },
  });
  coordinator.bindTransport(retentionTransport(node, invoke));
  let publication: Promise<void> | undefined;
  try {
    await coordinator.start();
    invoke.mockClear();
    holdPreparation = true;
    scheduler.schedule({
      id: "node-retention",
      delayMs: 60_000,
      run: async () => {
        publication = coordinator.schedule();
      },
    });
    await time.advanceBy(60_000);
    await preparing.promise;
    prepared.resolve(build);
    await publication;
    expect(warn).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({
      retain: [],
      bundleHashes: [build.bundleHash],
    });
  } finally {
    prepared.resolve(build);
    await publication;
    await coordinator.stop();
    await scheduler.stop();
  }
});

it("reads off thread and fences a placement created before mutation", async () => {
  const store = createWorkerSessionPlacementStore({ database });
  const first = await store.startDispatch(sessionIdentity("first"));
  const second = await store.startDispatch(sessionIdentity("second"));
  await store.getManyAsync([first.sessionId]);
  const sql = observeMainThreadSql();
  expect(await store.getManyAsync([" first ", "first", "missing"])).toEqual(
    new Map([[first.sessionId, first]]),
  );
  expect(await store.getAsync(` ${second.sessionId} `)).toEqual(second);
  expect(await store.getAsync("late-placement")).toBeUndefined();
  await expect(store.getAsync(" ")).rejects.toThrow("session id");
  expect(await store.getPlacementMoveAsync(second.sessionId)).toBeUndefined();
  expect(await store.listAsync()).toEqual([first, second]);
  expect(await store.listForReconcileAsync(second.sessionKey)).toEqual([second]);
  const assertCurrent = await prepareSessionWorkerPlacementMutationCheckAsync({
    context: { workerSessionPlacementService: store },
    sessionId: "late-placement",
  });
  sql.expectIdle();
  assertCurrent();
  const late = await store.startDispatch(sessionIdentity("late-placement"));
  expect(assertCurrent).toThrow("placement late-placement changed before mutation");
  expect(await store.getAsync(" late-placement ")).toEqual(late);
});

it("publishes retention without host SQL and fences drained dispatch", async () => {
  const { store, placement } = await activePlacement("node-retention");
  await store.claimTurn(placementClaim(placement, "retained"));
  const environments = await createWorkerEnvironmentStore({ database });
  const node = createNodeWorkerBundleTestNode();
  const environment = environments.get(placement.environmentId!);
  if (!environment) {
    throw new Error("Expected the seeded worker environment");
  }
  const nodeEnvironment = {
    ...environment,
    nodeDeviceId: node.nodeId,
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "connected" as const,
  };
  const entered = createDeferred<Parameters<NodeWorkerSupervisorTransport["invoke"]>[0]>();
  const reply = createDeferred();
  const warn = vi.fn();
  const coordinator = createNodeWorkspaceRetainCoordinator({
    gatewayNamespace: "gateway-retention",
    placements: store,
    environments: { list: () => [nodeEnvironment] },
    warn,
  });
  coordinator.bindTransport(
    retentionTransport(node, async (request) => {
      entered.resolve(request);
      await reply.promise;
      return {
        ok: true,
        payloadJSON: JSON.stringify({ applied: true, deleted: 0, hasMore: false }),
      };
    }),
  );
  const sql = observeMainThreadSql();
  const startup = coordinator.start();
  try {
    const request = await awaitGateBeforeSettlement(
      entered.promise,
      startup,
      "retention was not dispatched",
    );
    expect(request.params).toMatchObject({
      retain: [expect.objectContaining({ manifestRefs: null })],
    });
    expect(request.isDispatchAuthorized()).toBe(true);
    sql.expectIdle();
    await store.startDispatch(sessionIdentity("unrelated"));
    expect(request.isDispatchAuthorized()).toBe(true);
    await store.startDrain(placementTransition(placement));
    sql.clear();
    expect(request.isDispatchAuthorized()).toBe(false);
    expect(request.isCompletionAuthorized?.()).toBe(true);
    sql.expectIdle();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    reply.resolve();
    await startup;
    await coordinator.stop();
    await environments.close();
  }
});

it.each(["local", "worker-turn", "remote-exec"] as const)(
  "fences observations during %s publication settlement",
  async (kind) => {
    const store = createWorkerSessionPlacementStore({ database });
    const session = sessionIdentity("settling-placement");
    if (kind !== "local") {
      await activePlacement(session.sessionId, kind);
    }
    const current = await store.getAsync(session.sessionId);
    await store.claimTurn({
      ...session,
      owner: current?.state === "active" ? placementTurnOwner(current) : { kind: "local" },
      claimId: "settling-claim",
      runId: "settling-run",
    });
    const placement = store.get(session.sessionId)!;
    const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
    for (const settlement of ["rollback", "commit", "invalidate"] as const) {
      const sessionRead = await store.prepareRuntimeRefresh(session.sessionId);
      const publication = stagePlacementTurnClaimWorkerPublication(
        identity,
        placement,
        undefined,
        placement.state,
      );
      try {
        expect(() => sessionRead.assertCurrent()).toThrow("placement authority changed");
        publication[settlement]();
        if (settlement === "rollback") {
          sessionRead.assertCurrent();
        } else {
          expect(() => sessionRead.assertCurrent()).toThrow("placement authority changed");
        }
      } finally {
        publication.rollback();
        sessionRead.release();
      }
    }
    const closing = await store.prepareMaintenancePlacements();
    try {
      await closeOpenClawStateDatabaseAsync();
      expect(() => closing.assertCurrent()).toThrow();
    } finally {
      closing.release();
    }
  },
);

it("derives inference without rewriting its bound snapshot", async () => {
  const sessionId = "snapshot-worker";
  const environmentId = "environment-" + sessionId;
  const profileSnapshot = { settings: { device: "paired-node", inference: "worker" } };
  writePlacementEnvironmentFixture(database, {
    environmentId,
    state: "attached",
    ownerEpoch: 7,
    attachedSessionIds: [sessionId],
    providerId: "device",
    profileId: "named-device",
    nodeDeviceId: "paired-node",
    profileSnapshot,
  });
  const { store, placement } = await activePlacement(sessionId);
  const snapshot = await store.readProjection([sessionId]);
  const environment = snapshot.environments.get(environmentId);
  expect(environment).toMatchObject({ profileSnapshot, inference: "worker" });
  const identity = readWorkerPlacementIdentity(placement, undefined, environment);
  const projected = projectWorkerSessionPlacement(placement, undefined, undefined, identity);
  expect(projected).toHaveProperty("inference", "worker");
  expect(projected).not.toHaveProperty("profileSnapshot");
  expect(
    (await store.readProjection([sessionId])).environments.get(environmentId)?.profileSnapshot,
  ).toEqual(profileSnapshot);
});

it("discovers disk probes off thread before sampling", async () => {
  const last = await activePlacement("z-disk");
  const first = await activePlacement("a-disk");
  const store = createWorkerSessionPlacementStore({ database, now: () => 2000 });
  const claim = await store.claimTurn(placementClaim(first.placement, "recent-disk"));
  await store.releaseTurn(claim);
  await store.startDispatch(sessionIdentity("inactive-disk"));
  const sample = spawnResult({
    stdout: JSON.stringify({
      availableBytes: String(6 * 1024 ** 3),
      totalBytes: String(10 * 1024 ** 3),
    }),
  });
  const unexpected = async () => {
    throw new Error("unexpected workspace mutation during a disk probe");
  };
  const sql = observeHostDataSql();
  expect(store.get(first.placement.sessionId)?.state).toBe("active");
  expect(sql.queries).toEqual([]);
  let discoverySql: string[] | undefined;
  const requestedEnvironments: string[] = [];
  const warn = vi.fn();
  const monitor = createWorkerPlacementDiskSpaceMonitor({
    placements: store,
    runnerAvailability: { read: () => undefined, version: () => 0 },
    environments: {
      async startTunnel({ environmentId, ownerEpoch }) {
        discoverySql ??= sql.queries.slice();
        requestedEnvironments.push(environmentId);
        return {
          environmentId,
          ownerEpoch,
          runWorkspaceCommand: async () => sample,
          quiesceWorkspace: unexpected,
          syncWorkspace: unexpected,
          reconcileWorkspace: unexpected,
          stop: async () => {},
        };
      },
    },
    warn,
    now: () => 2000,
  });
  await monitor.sweep();

  expect(discoverySql).toEqual([]);
  expect(requestedEnvironments.toSorted()).toEqual([
    first.placement.environmentId,
    last.placement.environmentId,
  ]);
  for (const { placement } of [first, last]) {
    expect(monitor.read(store.get(placement.sessionId)!)).toEqual({
      status: "ok",
      availableBytes: 6 * 1024 ** 3,
      totalBytes: 10 * 1024 ** 3,
      observedAtMs: 2000,
    });
  }
  expect(monitor.version()).toBe(2);
  expect(warn).not.toHaveBeenCalled();
});

it("reads all projection facts off the host SQLite thread", async () => {
  const otherStateDir = roots.make("placement-projection-other-");
  const { store, placement, identity } = await activePlacement("pending");
  const claim = await store.claimTurn(placementClaim(placement, "pending"));
  await store.markWorkspaceResultPending(claim);
  const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
  await store.recordStagedWorkspaceResult(claim, stagedResultRef);
  store.recordWorkspaceResultConflict(claim, { paths: ["changed.txt"], stagedResultRef });
  const draining = await store.startWorkspaceResultDrain(claim);
  const pendingResult = (await store.listPendingWorkspaceResultsAsync("pending"))[0];
  const moving = await activePlacement("moving");
  const move = await moving.store.beginPlacementMove({
    sessionId: moving.placement.sessionId,
    source: placementSource(moving.placement),
    target: { kind: "gateway" },
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", otherStateDir);
  const other = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  await other.startDispatch(identity);
  await closeOpenClawStateDatabaseAsync();
  requireNodeSqlite();
  const counters = observeMainThreadSql({ includeClose: true });
  const pendingIds = ["pending", " pending "];
  const movingIds = ["moving", " moving "];
  const snapshot = await store.readProjection([...pendingIds, ...movingIds, "missing"]);
  expect(snapshot.placements.get("pending")).toMatchObject({
    state: "draining",
    generation: draining.generation,
    workspaceResultConflict: { paths: ["changed.txt"], stagedResultRef, totalCount: 1 },
  });
  expect(snapshot.placements.get(" pending ")).toEqual(snapshot.placements.get("pending"));
  for (const id of movingIds) {
    expect(snapshot.placements.get(id)).toEqual(move.placement);
    expect(snapshot.moves.get(id)).toEqual(move.intent);
  }
  expect(snapshot.placements.has("missing")).toBe(false);
  expect(snapshot.pendingResults).toEqual(new Map(pendingIds.map((id) => [id, pendingResult])));
  expect(snapshot.workspaceResultReconcilingSessionIds).toEqual(new Set(pendingIds));
  expect(snapshot.workspaceRecoveryPendingSessionIds).toEqual(new Set(pendingIds));
  expect(snapshot.environments.get(placement.environmentId)).toEqual({
    environmentId: placement.environmentId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: {} },
    state: "attached",
    leaseId: `lease:${placement.environmentId}`,
    ownerEpoch: 7,
    nodeDeviceId: null,
    attachedSessionIds: ["pending"],
  });
  const cancelled = new AbortController();
  cancelled.abort(new Error("Worker environment reconciliation stopped"));
  await expect(
    store.readEnvironmentOwner(placement.environmentId, cancelled.signal),
  ).rejects.toThrow("Worker environment reconciliation stopped");
  expect(await store.readEnvironmentOwner(placement.environmentId)).toMatchObject({
    sessionId: "pending",
    state: "draining",
    generation: draining.generation,
  });
  expect(await store.readEnvironmentOwner("missing-environment")).toBeUndefined();
  expect((await other.readProjection(["pending"])).placements.get("pending")?.state).toBe(
    "requested",
  );
  await closeOpenClawStateDatabaseAsync();
  expect(await store.readEnvironmentOwner(moving.placement.environmentId)).toEqual(move.placement);
  expect((await store.readProjection(["pending"])).placements.get("pending")?.generation).toBe(
    draining.generation,
  );
  counters.expectIdle();
});

it.each([false, true])(
  "reads recovery facts and candidate order (repository column %s)",
  async (repositoryColumn) => {
    const { db } = database;
    const store = createWorkerSessionPlacementStore({ database });
    if (!repositoryColumn) {
      db.exec("ALTER TABLE worker_workspace_pending_results DROP COLUMN repository_workspace_id");
    }
    const rows = [
      ["a-requested", "requested", 100, 0],
      ["b-requested", "requested", 100, 0],
      ["journal-current", "active", 200, 7],
      ["journal-draining", "draining", 300, 8],
      ["journal-stale", "draining", 400, 8],
      ["result-reclaimed", "reclaimed", 50, 7],
      ["move-a-local", "local", 20, 0],
      ["move-z-local", "local", 20, 0],
      ["journal-local", "local", 10, 0],
      ["idle-local", "local", 0, 0],
    ] as const;
    for (const [sessionId, state, updatedAt, generation] of rows) {
      const remote = state !== "local" && state !== "requested";
      insertFixtureRow(db, "worker_session_placements", {
        ...sessionIdentity(sessionId),
        state,
        transitionGeneration: generation,
        environmentId: remote ? `env-${sessionId}` : null,
        activeOwnerEpoch: remote ? 7 : null,
        workspaceBaseManifestRef: remote ? `sha256:${"a".repeat(64)}` : null,
        remoteWorkspaceDir: remote ? "/workspace" : null,
        workerBundleHash: remote ? "b".repeat(64) : null,
        createdAtMs: 0,
        updatedAtMs: updatedAt,
        stateChangedAtMs: 0,
      });
    }
    for (const sessionId of [
      "journal-current",
      "journal-draining",
      "journal-stale",
      "journal-local",
    ]) {
      db.prepare(`INSERT INTO worker_workspace_reconciliations
        (session_id, environment_id, owner_epoch, placement_generation, base_manifest_ref,
         current_manifest_ref, plan_json, base_pack, created_at_ms)
        VALUES (?, ?, 7, 7, 'base', 'current', '{}', X'', 0)`).run(sessionId, `env-${sessionId}`);
    }
    const pendingResults = [
      "journal-current",
      "journal-draining",
      "journal-stale",
      "result-reclaimed",
    ].map((sessionId) => {
      const pending: WorkerWorkspacePendingResult = {
        sessionId,
        environmentId: `env-${sessionId}`,
        ownerEpoch: sessionId === "journal-stale" ? 8 : 7,
        placementGeneration: 7,
        claimId: `claim-${sessionId}`,
        runId: `run-${sessionId}`,
        gatewayInstanceId: "previous-gateway",
        recoveryRequestedAtMs: sessionId === "journal-current" ? null : 11,
        workspaceAcceptedAtMs: sessionId === "result-reclaimed" ? 12 : null,
        stagedResultRef:
          sessionId === "journal-current" ? null : `refs/openclaw/worker-results/${sessionId}`,
      };
      if (repositoryColumn && sessionId === "result-reclaimed") {
        pending.repositoryWorkspaceId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
      }
      return pending;
    });
    for (const pending of pendingResults) {
      insertFixtureRow(db, "worker_workspace_pending_results", { ...pending, createdAtMs: 0 });
    }
    for (const [sessionId, createdAt] of [
      ["move-z-local", 1],
      ["move-a-local", 2],
    ] as const) {
      insertFixtureRow(db, "worker_session_placement_moves", {
        operationId: `move:v1:${sessionId}`,
        sessionId,
        sourceGeneration: 7,
        sourceEnvironmentId: `source-${sessionId}`,
        sourceOwnerEpoch: 7,
        targetKind: "gateway",
        createdAtMs: createdAt,
        updatedAtMs: createdAt,
      });
    }
    const journalOwners = await store.listWorkspaceReconciliationOwners();
    const journalPlacements = await Promise.all(
      journalOwners.map((owner) => store.getWorkspaceReconciliationPlacement(owner)),
    );
    const blockingOwners = new Set(
      journalOwners
        .filter((_owner, index) => journalPlacements[index])
        .map((owner) => owner.sessionId),
    );
    expect(blockingOwners).toEqual(new Set(["journal-current", "journal-draining"]));
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual(pendingResults);
    const orderedIds = [
      "a-requested",
      "b-requested",
      "journal-current",
      "journal-draining",
      "journal-stale",
      "move-z-local",
      "move-a-local",
      "result-reclaimed",
      "journal-local",
    ];
    const counters = observeMainThreadSql();
    const projection = await store.readProjection(
      [...rows.map(([sessionId]) => sessionId), " journal-current "],
      { current: true },
    );
    expect(projection.pendingResults).toEqual(
      new Map([
        ...pendingResults.map((pending) => [pending.sessionId, pending] as const),
        [" journal-current ", pendingResults[0]],
      ]),
    );
    expect(projection.workspaceJournalOwnerSessionIds).toEqual(
      new Set([...blockingOwners, " journal-current "]),
    );
    expect(projection.workspaceRecoveryPendingSessionIds).toEqual(
      new Set([
        "journal-current",
        "journal-draining",
        "journal-stale",
        "journal-local",
        "result-reclaimed",
        " journal-current ",
      ]),
    );
    expect(projection.moves.get("move-z-local")).toMatchObject({
      sessionId: "move-z-local",
      source: { environmentId: "source-move-z-local" },
    });
    expect(projection.workspaceResultReconcilingSessionIds).toEqual(new Set(["journal-draining"]));
    const candidates = await store.readRecoveryCandidates();
    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(orderedIds);
    expect(candidates.find((candidate) => candidate.sessionId === "move-z-local")).toEqual({
      sessionId: "move-z-local",
      state: "local",
      environmentId: null,
      moveSourceEnvironmentId: "source-move-z-local",
    });
    expect(candidates.find((candidate) => candidate.sessionId === "journal-draining")).toEqual({
      sessionId: "journal-draining",
      state: "draining",
      environmentId: "env-journal-draining",
    });
    counters.expectIdle();
    db.prepare("UPDATE worker_session_placements SET updated_at_ms = ? WHERE session_id = ?").run(
      9_007_199_254_740_993n,
      "idle-local",
    );
    await expect(store.readProjection(["idle-local"], { current: true })).rejects.toThrow();
  },
);

it("prepares live and claimless result authority for both execution modes", async () => {
  for (const executionMode of ["worker-turn", "remote-exec"] as const) {
    const { store, placement, identity } = await activePlacement(executionMode, executionMode);
    const claim = await store.claimTurn(placementClaim(placement, executionMode));
    await store.markWorkspaceResultPending(claim);
    for (const claimless of [false, true]) {
      if (claimless) {
        if (executionMode === "remote-exec") {
          expect(await store.clearLocalTurnClaimsAfterRestartAsync()).toBe(1);
        } else {
          database.db
            .prepare(`UPDATE worker_session_placements SET turn_claim_owner = NULL, turn_claim_id = NULL,
              turn_claim_run_id = NULL, turn_claim_generation = NULL, turn_claim_owner_epoch = NULL WHERE session_id = ?`)
            .run(identity.sessionId);
        }
      }
      const projection = await store.readProjection([identity.sessionId], { current: true });
      const projectedPlacement = projection.placements.get(identity.sessionId)!;
      const pending = projection.pendingResults.get(identity.sessionId)!;
      for (const testedClaim of [
        claim,
        { ...claim, claimId: "different-claim" },
        { ...claim, runId: "different-run" },
        { ...claim, placementGeneration: claim.placementGeneration + 1 },
        { ...claim, owner: { ...claim.owner, environmentId: "different-environment" } },
        { ...claim, owner: { ...claim.owner, ownerEpoch: 8 } },
      ]) {
        const expected = testedClaim === claim && (!claimless || executionMode === "remote-exec");
        if (expected) {
          await store.prepareWorkspaceResultClaim(testedClaim);
        } else {
          await expect(store.prepareWorkspaceResultClaim(testedClaim)).rejects.toThrow(
            "workspace result authority changed",
          );
        }
        expect(store.validateWorkspaceResultClaim(testedClaim)).toBe(expected);
        expect(matchesWorkspaceResultClaim(projectedPlacement, pending, testedClaim)).toBe(
          expected,
        );
      }
    }
  }
});
