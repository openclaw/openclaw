import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { placementTurnOwner, type WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import {
  matchesWorkspaceResultClaim,
  type WorkerWorkspacePendingResult,
} from "./placement-workspace-result.js";

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
  seedAttachedPlacementEnvironment(database, { environmentId, sessionId, ownerEpoch: 7 });
  let placement = await store.startDispatch({ ...identity, executionMode });
  for (const step of [
    { to: "provisioning", patch: { environmentId } },
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
    placement = store.transition({
      sessionId,
      from: placement.state,
      expectedGeneration: placement.generation,
      ...step,
    });
  }
  assert(placement.state === "active", "Expected an active placement fixture");
  return { store, placement, identity };
}

describe("worker placement read projection", () => {
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
    store.markWorkspaceResultPending(claim);
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    store.recordStagedWorkspaceResult(claim, stagedResultRef);
    store.recordWorkspaceResultConflict(claim, { paths: ["changed.txt"], stagedResultRef });
    const draining = store.startWorkspaceResultDrain(claim);
    const pendingResult = store.listPendingWorkspaceResults("pending")[0];
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
      const journalOwners = store.listWorkspaceReconciliationOwners();
      const blockingOwners = new Set(
        journalOwners
          .filter((owner) => store.getWorkspaceReconciliationPlacement(owner))
          .map((owner) => owner.sessionId),
      );
      expect(blockingOwners).toEqual(new Set(["journal-current", "journal-draining"]));
      expect(store.listPendingWorkspaceResults()).toEqual(pendingResults);
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

  it("matches synchronous pending-result claim authority for live and claimless worker and local owners", async () => {
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
      store.markWorkspaceResultPending(claim);
      for (const claimless of [false, true]) {
        if (claimless) {
          database.db
            .prepare(`UPDATE worker_session_placements SET turn_claim_owner = NULL, turn_claim_id = NULL,
            turn_claim_run_id = NULL, turn_claim_generation = NULL, turn_claim_owner_epoch = NULL WHERE session_id = ?`)
            .run(identity.sessionId);
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
          expect(store.validateWorkspaceResultClaim(testedClaim)).toBe(expected);
          expect(matchesWorkspaceResultClaim(projectedPlacement, pending, testedClaim)).toBe(
            expected,
          );
        }
      }
    }
  });
});
