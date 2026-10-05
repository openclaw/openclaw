import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { SpawnResult } from "../../process/exec.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createNodeWorkspaceRetainCoordinator } from "./node-workspace-retain-coordinator.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./placement-disk-space.js";
import { placementTurnOwner, type WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { stagePlacementTurnClaimWorkerPublication } from "./placement-turn-authority.js";
import { matchesWorkspaceResultClaim } from "./placement-workspace-result.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { createWorkerEnvironmentStore } from "./store.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await drainGlobalSingletonLifecycleState();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }),
);

async function activePlacement(
  database: OpenClawStateDatabase,
  sessionId: string,
  executionMode: WorkerPlacementExecutionMode = "worker-turn",
) {
  const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const identity = { sessionId, agentId: "main", sessionKey: `agent:main:${sessionId}` };
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

describe("worker placement read projection", () => {
  it("publishes node retention without host SQL and refuses a drained placement on the next authority check", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-node-retention-"));
    const database = openOpenClawStateDatabase();
    const { store, placement, identity } = await activePlacement(database, "node-retention");
    await store.claimTurn({
      ...identity,
      owner: placementTurnOwner(placement),
      claimId: "retained-claim",
      runId: "retained-run",
    });
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
      environments: {
        list: () => [nodeEnvironment],
      },
      warn,
    });
    coordinator.bindTransport({
      getCurrentNode: async () => node,
      listCurrentNodes: async () => [node],
      hasCurrentRunner: () => true,
      isCurrent: () => true,
      invoke: async (request) => {
        entered.resolve(request);
        await reply.promise;
        return {
          ok: true,
          payloadJSON: JSON.stringify({ applied: true, deleted: 0, hasMore: false }),
        };
      },
    });
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
      await store.startDispatch({
        sessionId: "unrelated",
        sessionKey: "agent:main:unrelated",
        agentId: "main",
      });
      expect(request.isDispatchAuthorized()).toBe(true);
      await store.startDrain({
        sessionId: placement.sessionId,
        environmentId: placement.environmentId!,
        ownerEpoch: placement.activeOwnerEpoch!,
        expectedGeneration: placement.generation,
      });
      sql.clear();
      expect(request.isDispatchAuthorized()).toBe(false);
      sql.expectIdle();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      reply.resolve();
      await startup;
      await coordinator.stop();
      sql.restore();
      await environments.close();
    }
  });

  it("refreshes admission facts when the preceding turn releases during its read", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-admission-refresh-"));
    const database = openOpenClawStateDatabase();
    const { store, placement, identity } = await activePlacement(database, "next-turn");
    const claim = await store.claimTurn({
      ...identity,
      owner: placementTurnOwner(placement),
      claimId: "preceding-claim",
      runId: "preceding-run",
    });
    const read = store.readProjection.bind(store);
    const observed = createDeferred();
    const resume = createDeferred();
    vi.spyOn(store, "readProjection").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      observed.resolve();
      await resume.promise;
      return result;
    });
    const sql = observeMainThreadSql();
    const preparing = store.prepareRuntimeRefresh(identity.sessionId);
    const settled = preparing.catch(() => undefined);
    try {
      await awaitGateBeforeSettlement(observed.promise, preparing, "placement read was skipped");
      await store.releaseTurn(claim);
      resume.resolve();
      const prepared = await preparing;
      try {
        expect(prepared.placement).toMatchObject({
          state: "active",
          generation: placement.generation,
          turnClaim: null,
        });
        prepared.assertCurrent();
        sql.expectIdle();
      } finally {
        prepared.release();
      }
    } finally {
      resume.resolve();
      await settled;
      sql.restore();
    }
  });

  it("joins publication settlement and keeps unknown, closed, and cancelled reads fenced", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-admission-pending-"));
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const placement = await store.startDispatch({
      sessionId: "pending-publication",
      sessionKey: "agent:main:pending-publication",
      agentId: "main",
    });
    const read = vi.spyOn(store, "readProjection");
    for (const settlement of ["commit", "rollback", "invalidate", "cancel", "close"] as const) {
      const previous = await store.prepareRuntimeRefresh(placement.sessionId);
      const publication = stagePlacementTurnClaimWorkerPublication(
        requireOpenClawStateDatabaseIdentity({ db: database.db }),
        placement,
      );
      read.mockClear();
      const scope = new AsyncWorkScope();
      const preparing = scope.track(() => store.prepareRuntimeRefresh(placement.sessionId));
      const settled = preparing.catch(() => undefined);
      try {
        expect(read).not.toHaveBeenCalled();
        if (settlement === "close") {
          await closeOpenClawStateDatabaseAsync();
        } else if (settlement === "cancel") {
          scope.beginClose();
        } else {
          publication[settlement]();
        }
        if (settlement === "commit" || settlement === "rollback") {
          const prepared = await preparing;
          try {
            expect(prepared.placement).toEqual(placement);
            prepared.assertCurrent();
            expect(read).toHaveBeenCalledOnce();
          } finally {
            prepared.release();
          }
        } else {
          await expect(preparing).rejects.toThrow();
          expect(read).not.toHaveBeenCalled();
        }
        if (settlement === "cancel") {
          // Abandoning this reader cannot settle the independent accepted writer.
          expect(() => previous.assertCurrent()).toThrow("placement authority changed");
          publication.rollback();
          previous.assertCurrent();
        }
      } finally {
        publication.rollback();
        previous.release();
        await settled;
        await scope.drain();
      }
    }
  });

  it("invalidates an empty maintenance scan when a new placement commits", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-maintenance-inventory-"));
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const empty = await store.prepareMaintenancePlacements();
    try {
      expect(empty.placements).toEqual([]);
      const placement = await store.startDispatch({
        sessionId: "new-placement",
        sessionKey: "agent:main:new-placement",
        agentId: "main",
      });
      expect(() => empty.assertCurrent()).toThrow("placement inventory changed");
      const current = await store.prepareMaintenancePlacements();
      try {
        expect(current.placements).toEqual([placement]);
        current.assertCurrent();
      } finally {
        current.release();
      }
      expect(() => current.assertCurrent()).toThrow("placement inventory changed");
    } finally {
      empty.release();
    }
  });

  it("keeps maintenance observations fenced until their placement publication settles", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-maintenance-settlement-"));
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database });
    const placement = await store.startDispatch({
      sessionId: "settling-placement",
      sessionKey: "agent:main:settling-placement",
      agentId: "main",
    });
    const identity = requireOpenClawStateDatabaseIdentity({ db: database.db });
    for (const settlement of ["rollback", "commit", "invalidate"] as const) {
      const prepared = await store.prepareMaintenancePlacements();
      try {
        const publication = stagePlacementTurnClaimWorkerPublication(identity, placement);
        expect(() => prepared.assertCurrent()).toThrow("placement inventory changed");
        publication[settlement]();
        if (settlement === "rollback") {
          expect(() => prepared.assertCurrent()).not.toThrow();
        } else {
          expect(() => prepared.assertCurrent()).toThrow("placement inventory changed");
        }
      } finally {
        prepared.release();
      }
    }
    const closing = await store.prepareMaintenancePlacements();
    try {
      await closeOpenClawStateDatabaseAsync();
      expect(() => closing.assertCurrent()).toThrow();
    } finally {
      closing.release();
    }
  });

  it("discovers disk-probe placements off thread in session order before live sample checks", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-disk-inventory-"));
    const database = openOpenClawStateDatabase();
    const last = await activePlacement(database, "z-disk");
    const first = await activePlacement(database, "a-disk");
    const store = createWorkerSessionPlacementStore({ database, now: () => 2000 });
    const claim = await store.claimTurn({
      ...first.identity,
      owner: placementTurnOwner(first.placement),
      claimId: "recent-disk-turn",
      runId: "recent-disk-run",
    });
    await store.releaseTurn(claim);
    await store.startDispatch({
      sessionId: "inactive-disk",
      sessionKey: "agent:main:inactive-disk",
      agentId: "main",
    });
    const sample: SpawnResult = {
      stdout: JSON.stringify({
        availableBytes: String(6 * 1024 ** 3),
        totalBytes: String(10 * 1024 ** 3),
      }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    };
    const unexpected = async () => {
      throw new Error("unexpected workspace mutation during a disk probe");
    };
    const sql = observeHostDataSql();
    try {
      expect(store.get(first.placement.sessionId)?.state).toBe("active");
      expect(sql.queries.length).toBeGreaterThan(0);
      const beforeSweep = sql.queries.length;
      let discoverySql: string[] | undefined;
      const requestedEnvironments: string[] = [];
      const warn = vi.fn();
      const monitor = createWorkerPlacementDiskSpaceMonitor({
        placements: store,
        runnerAvailability: { read: () => undefined },
        environments: {
          async startTunnel({ environmentId, ownerEpoch }) {
            discoverySql ??= sql.queries.slice(beforeSweep);
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
      expect(requestedEnvironments).toEqual([
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
    } finally {
      sql.restore();
    }
  });

  it("reads placement, move, pending-result and environment facts off the host SQLite thread", async () => {
    const stateDir = roots.make("placement-projection-worker-");
    const otherStateDir = roots.make("placement-projection-other-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const database = openOpenClawStateDatabase();
    const { store, placement, identity } = await activePlacement(database, "pending");
    const claim = await store.claimTurn({
      ...identity,
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
      claimId: "pending-claim",
      runId: "pending-run",
    });
    await store.markWorkspaceResultPending(claim);
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    await store.recordStagedWorkspaceResult(claim, stagedResultRef);
    store.recordWorkspaceResultConflict(claim, { paths: ["changed.txt"], stagedResultRef });
    const draining = await store.startWorkspaceResultDrain(claim);
    const pendingResult = (await store.listPendingWorkspaceResultsAsync("pending"))[0];
    const moving = await activePlacement(database, "moving");
    const move = moving.store.beginPlacementMove({
      sessionId: moving.placement.sessionId,
      source: {
        generation: moving.placement.generation,
        environmentId: moving.placement.environmentId,
        ownerEpoch: moving.placement.activeOwnerEpoch,
      },
      target: { kind: "gateway" },
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", otherStateDir);
    const other = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    await other.startDispatch(identity);
    await closeOpenClawStateDatabaseAsync();
    requireNodeSqlite();
    const counters = observeMainThreadSql({ includeClose: true });
    try {
      const snapshot = await store.readProjection([
        "pending",
        " pending ",
        "moving",
        " moving ",
        "missing",
      ]);
      expect(snapshot.placements.get("pending")).toMatchObject({
        state: "draining",
        generation: draining.generation,
        workspaceResultConflict: { paths: ["changed.txt"], stagedResultRef, totalCount: 1 },
      });
      expect(snapshot.placements.get("moving")).toEqual(move.placement);
      expect(snapshot.placements.get(" pending ")).toEqual(snapshot.placements.get("pending"));
      expect(snapshot.placements.get(" moving ")).toEqual(move.placement);
      expect(snapshot.placements.has("missing")).toBe(false);
      expect(snapshot.pendingResults).toEqual(
        new Map([
          ["pending", pendingResult],
          [" pending ", pendingResult],
        ]),
      );
      expect(snapshot.moves.get("moving")).toEqual(move.intent);
      expect(snapshot.moves.get(" moving ")).toEqual(move.intent);
      expect(snapshot.workspaceResultReconcilingSessionIds).toEqual(
        new Set(["pending", " pending "]),
      );
      expect(snapshot.workspaceRecoveryPendingSessionIds).toEqual(
        new Set(["pending", " pending "]),
      );
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
      expect((await other.readProjection(["pending"])).placements.get("pending")?.state).toBe(
        "requested",
      );
      await closeOpenClawStateDatabaseAsync();
      expect((await store.readProjection(["pending"])).placements.get("pending")?.generation).toBe(
        draining.generation,
      );
      counters.expectIdle();
    } finally {
      counters.restore();
    }
  });

  it.each([false, true])(
    "reads exact recovery facts and candidate order with repository column %s",
    async (repositoryColumn) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-recovery-projection-"));
      const database = openOpenClawStateDatabase();
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
        db.prepare(`INSERT INTO worker_session_placements
        (session_id, agent_id, session_key, state, transition_generation, environment_id,
         active_owner_epoch, workspace_base_manifest_ref, remote_workspace_dir, worker_bundle_hash,
         created_at_ms, updated_at_ms, state_changed_at_ms)
        VALUES (?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)`).run(
          sessionId,
          `agent:main:${sessionId}`,
          state,
          generation,
          remote ? `env-${sessionId}` : null,
          remote ? 7 : null,
          remote ? `sha256:${"a".repeat(64)}` : null,
          remote ? "/workspace" : null,
          remote ? "b".repeat(64) : null,
          updatedAt,
        );
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
      const pendingResults = ["journal-current", "journal-draining", "result-reclaimed"].map(
        (sessionId) => {
          const pending: WorkerWorkspacePendingResult = {
            sessionId,
            environmentId: `env-${sessionId}`,
            ownerEpoch: 7,
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
        },
      );
      for (const pending of pendingResults) {
        db.prepare(`INSERT INTO worker_workspace_pending_results
        (session_id, environment_id, owner_epoch, placement_generation, claim_id, run_id,
         gateway_instance_id, recovery_requested_at_ms, workspace_accepted_at_ms, staged_result_ref, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
          pending.sessionId,
          pending.environmentId,
          pending.ownerEpoch,
          pending.placementGeneration,
          pending.claimId,
          pending.runId,
          pending.gatewayInstanceId,
          pending.recoveryRequestedAtMs,
          pending.workspaceAcceptedAtMs,
          pending.stagedResultRef,
        );
        if (pending.repositoryWorkspaceId) {
          db.prepare(
            "UPDATE worker_workspace_pending_results SET repository_workspace_id = ? WHERE session_id = ?",
          ).run(pending.repositoryWorkspaceId, pending.sessionId);
        }
      }
      for (const [sessionId, createdAt] of [
        ["move-z-local", 1],
        ["move-a-local", 2],
      ] as const) {
        db.prepare(`INSERT INTO worker_session_placement_moves
        (operation_id, session_id, source_generation, source_environment_id, source_owner_epoch,
         target_kind, created_at_ms, updated_at_ms)
        VALUES (?, ?, 7, ?, 7, 'gateway', ?, ?)`).run(
          `move:v1:${sessionId}`,
          sessionId,
          `source-${sessionId}`,
          createdAt,
          createdAt,
        );
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
        ...new Set([
          ...store.listForReconcile().map((placement) => placement.sessionId),
          ...db
            .prepare(
              "SELECT session_id FROM worker_session_placement_moves ORDER BY created_at_ms, session_id",
            )
            .all()
            .map((row) => row.session_id),
          ...pendingResults.map((pending) => pending.sessionId),
          ...journalOwners.map((owner) => owner.sessionId),
        ]),
      ];
      expect(orderedIds).toEqual([
        "a-requested",
        "b-requested",
        "journal-current",
        "journal-draining",
        "journal-stale",
        "move-z-local",
        "move-a-local",
        "result-reclaimed",
        "journal-local",
      ]);
      const counters = observeMainThreadSql();
      try {
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
      } finally {
        counters.restore();
      }
    },
  );

  it("prepares pending-result claim authority for live and claimless worker and local owners", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", roots.make("placement-result-claim-projection-"));
    const database = openOpenClawStateDatabase();
    for (const executionMode of ["worker-turn", "remote-exec"] as const) {
      const { store, placement, identity } = await activePlacement(
        database,
        executionMode,
        executionMode,
      );
      const claim = await store.claimTurn({
        ...identity,
        owner: placementTurnOwner(placement),
        claimId: `claim-${executionMode}`,
        runId: `run-${executionMode}`,
      });
      await store.markWorkspaceResultPending(claim);
      for (const claimless of [false, true]) {
        if (claimless) {
          if (executionMode === "remote-exec") {
            expect(store.clearLocalTurnClaimsAfterRestart()).toBe(1);
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
});
