import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import {
  find as findPlacement,
  getRequired,
  query as placementQuery,
  transitionValues,
} from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";

type WorkspaceResultDatabase = Pick<
  StateDatabase,
  "worker_session_placements" | "worker_workspace_pending_results"
>;

const query = (db: DatabaseSync) => getNodeSqliteKysely<WorkspaceResultDatabase>(db);

type WorkerWorkspacePendingResult = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  claimId: string;
  runId: string;
  gatewayInstanceId: string;
  recoveryRequestedAtMs: number | null;
  workspaceAcceptedAtMs: number | null;
  stagedResultRef: string | null;
};

type WorkerWorkspaceResultOwnerIdentity = Pick<
  WorkerWorkspacePendingResult,
  "environmentId" | "ownerEpoch" | "placementGeneration"
>;

export function isRetainedFailedWorkspaceResultOwner(
  placement: WorkerSessionPlacementRecord | undefined,
  pending: WorkerWorkspaceResultOwnerIdentity,
): placement is Extract<WorkerSessionPlacementRecord, { state: "failed" }> {
  return (
    placement?.state === "failed" &&
    placement.turnClaim === null &&
    placement.environmentId === pending.environmentId &&
    placement.activeOwnerEpoch === pending.ownerEpoch &&
    placement.generation > pending.placementGeneration
  );
}

export function hasMatchingRetainedFailedWorkspaceResultOwner(
  db: DatabaseSync,
  placement: WorkerSessionPlacementRecord | undefined,
  owner: WorkerWorkspaceResultOwnerIdentity & { sessionId: string },
): boolean {
  const pending = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .select("session_id")
      .where("session_id", "=", owner.sessionId)
      .where("environment_id", "=", owner.environmentId)
      .where("owner_epoch", "=", owner.ownerEpoch)
      .where("placement_generation", "=", owner.placementGeneration),
  ).rows[0];
  return Boolean(pending && isRetainedFailedWorkspaceResultOwner(placement, owner));
}

export function clearWorkerWorkspacePendingResult(db: DatabaseSync, sessionId: string): void {
  executeSqliteQuerySync(
    db,
    query(db).deleteFrom("worker_workspace_pending_results").where("session_id", "=", sessionId),
  );
}

function deleteWorkerWorkspacePendingResult(
  db: DatabaseSync,
  pending: WorkerWorkspacePendingResult,
): void {
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_workspace_pending_results")
      .where("session_id", "=", pending.sessionId)
      .where("environment_id", "=", pending.environmentId)
      .where("owner_epoch", "=", pending.ownerEpoch)
      .where("placement_generation", "=", pending.placementGeneration)
      .where("claim_id", "=", pending.claimId)
      .where("run_id", "=", pending.runId),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker workspace result changed for ${pending.sessionId}`);
  }
}

export function hasWorkerWorkspacePendingResult(db: DatabaseSync, sessionId: string): boolean {
  return Boolean(
    executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .select("session_id")
        .where("session_id", "=", sessionId),
    ).rows[0],
  );
}

export function hasAcceptedWorkerWorkspacePendingResult(
  db: DatabaseSync,
  sessionId: string,
): boolean {
  return Boolean(
    executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .where("workspace_accepted_at_ms", "is not", null),
    ).rows[0],
  );
}

export function insertWorkerWorkspacePendingResult(
  db: DatabaseSync,
  claim: WorkerSessionTurnClaim,
  nowMs: number,
  gatewayInstanceId: string,
): void {
  if (claim.owner.kind !== "worker") {
    throw new Error("Only a worker turn can retain a pending workspace result");
  }
  const placement = getRequired(db, claim.sessionId);
  const persisted = placement.turnClaim;
  if (
    (placement.state !== "active" && placement.state !== "draining") ||
    placement.environmentId !== claim.owner.environmentId ||
    placement.activeOwnerEpoch !== claim.owner.ownerEpoch ||
    persisted?.owner !== "worker" ||
    persisted.claimId !== claim.claimId ||
    persisted.runId !== claim.runId ||
    persisted.generation !== claim.placementGeneration ||
    persisted.ownerEpoch !== claim.owner.ownerEpoch
  ) {
    throw new Error(`Cannot retain stale worker workspace result for ${claim.sessionId}`);
  }
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("worker_workspace_pending_results")
      .values({
        session_id: claim.sessionId,
        environment_id: claim.owner.environmentId,
        owner_epoch: claim.owner.ownerEpoch,
        placement_generation: claim.placementGeneration,
        claim_id: claim.claimId,
        run_id: claim.runId,
        gateway_instance_id: gatewayInstanceId,
        recovery_requested_at_ms: null,
        workspace_accepted_at_ms: null,
        staged_result_ref: null,
        created_at_ms: nowMs,
      })
      .onConflict((conflict) => conflict.column("session_id").doNothing()),
  );
  if (result.numAffectedRows === 1n) {
    return;
  }
  const existing = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .selectAll()
      .where("session_id", "=", claim.sessionId),
  ).rows[0];
  if (
    !existing ||
    existing.environment_id !== claim.owner.environmentId ||
    existing.owner_epoch !== claim.owner.ownerEpoch ||
    existing.placement_generation !== claim.placementGeneration ||
    existing.claim_id !== claim.claimId ||
    existing.run_id !== claim.runId
  ) {
    throw new Error(`Worker workspace result is already pending for ${claim.sessionId}`);
  }
}

function markWorkerWorkspacePendingResultAccepted(
  db: DatabaseSync,
  claim: WorkerSessionTurnClaim,
  nowMs: number,
): void {
  if (claim.owner.kind !== "worker") {
    throw new Error("Only a worker turn can accept a pending workspace result");
  }
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_workspace_pending_results")
      .set({ workspace_accepted_at_ms: nowMs })
      .where("session_id", "=", claim.sessionId)
      .where("environment_id", "=", claim.owner.environmentId)
      .where("owner_epoch", "=", claim.owner.ownerEpoch)
      .where("placement_generation", "=", claim.placementGeneration)
      .where("claim_id", "=", claim.claimId)
      .where("run_id", "=", claim.runId),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Cannot accept stale worker workspace result for ${claim.sessionId}`);
  }
}

export function createPlacementWorkspaceResultOps(
  runtime: PlacementStoreRuntime,
  deps: { signalTurnClaimRelease: (path: string, sessionId: string) => void },
) {
  const { instanceId, now, path, read, write } = runtime;
  const assertPendingClaim = (db: DatabaseSync, claim: WorkerSessionTurnClaim) => {
    const row = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .selectAll()
        .where("session_id", "=", claim.sessionId),
    ).rows[0];
    if (
      claim.owner.kind !== "worker" ||
      !row ||
      row.environment_id !== claim.owner.environmentId ||
      row.owner_epoch !== claim.owner.ownerEpoch ||
      row.placement_generation !== claim.placementGeneration ||
      row.claim_id !== claim.claimId ||
      row.run_id !== claim.runId
    ) {
      throw new Error(`Cannot update stale worker workspace result for ${claim.sessionId}`);
    }
    return row;
  };
  return {
    workspaceResultInstanceId(): string {
      return instanceId;
    },

    isEnvironmentRetainedForOperatorRecovery(environmentId: string): boolean {
      const db = read();
      const pendingOwners = executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_workspace_pending_results")
          .select(["session_id", "environment_id", "owner_epoch", "placement_generation"])
          .where("environment_id", "=", environmentId),
      ).rows;
      return pendingOwners.some((owner) =>
        isRetainedFailedWorkspaceResultOwner(findPlacement(db, owner.session_id), {
          environmentId: owner.environment_id,
          ownerEpoch: owner.owner_epoch,
          placementGeneration: owner.placement_generation,
        }),
      );
    },

    listPendingWorkspaceResults(): WorkerWorkspacePendingResult[] {
      const db = read();
      return executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_workspace_pending_results")
          .select([
            "session_id",
            "environment_id",
            "owner_epoch",
            "placement_generation",
            "claim_id",
            "run_id",
            "gateway_instance_id",
            "recovery_requested_at_ms",
            "workspace_accepted_at_ms",
            "staged_result_ref",
          ])
          .orderBy("session_id"),
      ).rows.map((row) => ({
        sessionId: row.session_id,
        environmentId: row.environment_id,
        ownerEpoch: row.owner_epoch,
        placementGeneration: row.placement_generation,
        claimId: row.claim_id,
        runId: row.run_id,
        gatewayInstanceId: row.gateway_instance_id,
        recoveryRequestedAtMs: row.recovery_requested_at_ms,
        workspaceAcceptedAtMs: row.workspace_accepted_at_ms,
        stagedResultRef: row.staged_result_ref,
      }));
    },

    markWorkspaceResultPending(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        insertWorkerWorkspacePendingResult(db, claim, now(), instanceId);
      });
    },

    recordStagedWorkspaceResult(claim: WorkerSessionTurnClaim, stagedResultRef: string): void {
      if (!/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef)) {
        throw new Error("Worker workspace staged result reference is invalid");
      }
      write((db) => {
        const pending = assertPendingClaim(db, claim);
        if (pending.workspace_accepted_at_ms !== null) {
          throw new Error(`Cannot restage accepted worker workspace result for ${claim.sessionId}`);
        }
        if (pending.staged_result_ref && pending.staged_result_ref !== stagedResultRef) {
          throw new Error(`Worker workspace result ref changed for ${claim.sessionId}`);
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_workspace_pending_results")
            .set({ staged_result_ref: stagedResultRef })
            .where("session_id", "=", claim.sessionId)
            .where("claim_id", "=", claim.claimId)
            .where("run_id", "=", claim.runId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Cannot stage stale worker workspace result for ${claim.sessionId}`);
        }
      });
    },

    acceptWorkspaceResult(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        assertPendingClaim(db, claim);
        markWorkerWorkspacePendingResultAccepted(db, claim, now());
        // Keep the applied journal as the crash-safe marker until this fence is
        // accepted. Recovery then inspects reality instead of replaying a result.
        clearWorkerWorkspaceReconciliation(db, claim.sessionId);
      });
    },

    handoffWorkspaceResultRecovery(claim: WorkerSessionTurnClaim): void {
      write((db) => {
        const pending = assertPendingClaim(db, claim);
        if (pending.gateway_instance_id !== instanceId) {
          throw new Error(
            `Worker workspace result belongs to another gateway for ${claim.sessionId}`,
          );
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_workspace_pending_results")
            .set({ recovery_requested_at_ms: now() })
            .where("session_id", "=", claim.sessionId)
            .where("gateway_instance_id", "=", instanceId),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker workspace result changed for ${claim.sessionId}`);
        }
      });
    },

    forceAbandonPendingWorkspaceResult(input: {
      pending: WorkerWorkspacePendingResult;
      recoveryError: string;
    }): WorkerSessionPlacementRecord {
      const { pending } = input;
      const recoveryError = input.recoveryError.trim();
      if (!recoveryError) {
        throw new Error("Forced worker workspace abandonment error is required");
      }
      const outcome = write((db) => {
        const current = getRequired(db, pending.sessionId);
        const claim = current.turnClaim;
        const isCurrentOwner =
          (current.state === "active" || current.state === "draining") &&
          current.environmentId === pending.environmentId &&
          current.activeOwnerEpoch === pending.ownerEpoch &&
          current.generation === pending.placementGeneration &&
          claim?.owner === "worker" &&
          claim.claimId === pending.claimId &&
          claim.runId === pending.runId &&
          claim.generation === pending.placementGeneration &&
          claim.ownerEpoch === pending.ownerEpoch;
        const isRetainedFailedOwner = isRetainedFailedWorkspaceResultOwner(current, pending);
        if (!isCurrentOwner && !isRetainedFailedOwner) {
          throw new Error(
            `Cannot force-abandon stale worker workspace result for ${pending.sessionId}`,
          );
        }

        const updatedAtMs = now();
        const update =
          current.state === "failed"
            ? placementQuery(db)
                .updateTable("worker_session_placements")
                .set({ recovery_error: recoveryError, updated_at_ms: updatedAtMs })
                .where("session_id", "=", pending.sessionId)
                .where("state", "=", "failed")
                .where("transition_generation", "=", current.generation)
                .where("environment_id", "=", pending.environmentId)
                .where("active_owner_epoch", "=", pending.ownerEpoch)
                .where("turn_claim_owner", "is", null)
            : placementQuery(db)
                .updateTable("worker_session_placements")
                .set(transitionValues(current, "failed", { recoveryError }, updatedAtMs))
                .where("session_id", "=", pending.sessionId)
                .where("state", "=", current.state)
                .where("transition_generation", "=", current.generation)
                .where("environment_id", "=", pending.environmentId)
                .where("active_owner_epoch", "=", pending.ownerEpoch)
                .where("turn_claim_owner", "=", "worker")
                .where("turn_claim_id", "=", pending.claimId)
                .where("turn_claim_run_id", "=", pending.runId)
                .where("turn_claim_generation", "=", pending.placementGeneration)
                .where("turn_claim_owner_epoch", "=", pending.ownerEpoch);
        const result = executeSqliteQuerySync(db, update);
        if (result.numAffectedRows !== 1n) {
          throw new Error(
            `Pending worker result owner changed during forced abandonment for ${pending.sessionId}`,
          );
        }
        deleteWorkerWorkspacePendingResult(db, pending);
        return {
          record: getRequired(db, pending.sessionId),
          releasedClaim: current.turnClaim?.owner === "worker",
        };
      });
      if (outcome.releasedClaim) {
        deps.signalTurnClaimRelease(path, pending.sessionId);
      }
      return outcome.record;
    },

    abandonWorkspaceResult(pending: WorkerWorkspacePendingResult): void {
      write((db) => {
        deleteWorkerWorkspacePendingResult(db, pending);
      });
    },
  };
}
