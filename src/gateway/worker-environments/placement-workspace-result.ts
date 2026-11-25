import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { ensureRepositoryWorkspacePendingResultSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { assertRepositoryWorkspaceDiskIdentity } from "../../state/session-repository-workspaces.authority.js";
import { findSessionRepositoryWorkspaceInDatabase } from "../../state/session-repository-workspaces.kernel.js";
import { readWorkerPlacementMovesReadOnly } from "./placement-move-row-codec.js";
import {
  resolvePlacementTurnEnvironment,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { fromRow, getRequired } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { publishPlacementWorkspaceResultState } from "./placement-turn-authority.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";
import {
  matchesWorkspaceResultClaim,
  pendingResultFromRow,
} from "./placement-workspace-result-owner.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { findWorkerEnvironment } from "./store-row-codec.js";
type WorkspaceResultDatabase = Pick<
  StateDatabase,
  "worker_session_placements" | "worker_workspace_pending_results" | "session_repository_workspaces"
>;

const query = (db: EngineConnection) => getNodeSqliteKysely<WorkspaceResultDatabase>(db);

export async function findPendingWorkerWorkspaceResult(
  placements: {
    listPendingWorkspaceResultsAsync(sessionId?: string): Promise<WorkerWorkspacePendingResult[]>;
  },
  claim: WorkerSessionTurnClaim,
): Promise<WorkerWorkspacePendingResult | undefined> {
  return (await placements.listPendingWorkspaceResultsAsync(claim.sessionId)).find(
    (pending) =>
      pending.sessionId === claim.sessionId &&
      pending.claimId === claim.claimId &&
      pending.runId === claim.runId,
  );
}

export function hasCurrentWorkspaceResultClaim(
  db: EngineConnection,
  claim: WorkerSessionTurnClaim,
): boolean {
  const placement = getRequired(db, claim.sessionId);
  const row = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .selectAll()
      .where("session_id", "=", claim.sessionId),
  ).rows[0];
  return Boolean(row && matchesWorkspaceResultClaim(placement, pendingResultFromRow(row), claim));
}

export function clearWorkerWorkspacePendingResult(db: EngineConnection, sessionId: string): void {
  executeSqliteQuerySync(
    db,
    query(db).deleteFrom("worker_workspace_pending_results").where("session_id", "=", sessionId),
  );
  publishPlacementWorkspaceResultState(db, sessionId, null);
}

export function readWorkerWorkspaceReconciliationFacts(
  db: EngineConnection,
  sessionIds: readonly string[],
): {
  placements: ReadonlyMap<string, WorkerSessionPlacementRecord>;
  pendingResults: ReadonlyMap<string, WorkerWorkspacePendingResult>;
} {
  const placements = new Map<string, WorkerSessionPlacementRecord>();
  const pendingResults = new Map<string, WorkerWorkspacePendingResult>();
  for (let offset = 0; offset < sessionIds.length; offset += 250) {
    const chunk = sessionIds.slice(offset, offset + 250);
    for (const row of executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_session_placements")
        .selectAll()
        .where("session_id", "in", chunk),
    ).rows) {
      const placement = fromRow(row);
      placements.set(placement.sessionId, placement);
    }
    for (const row of executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("worker_workspace_pending_results")
        .selectAll()
        .where("session_id", "in", chunk),
    ).rows) {
      pendingResults.set(row.session_id, pendingResultFromRow(row));
    }
  }
  return {
    placements,
    pendingResults,
  };
}

export function hasWorkerWorkspacePendingResult(db: EngineConnection, sessionId: string): boolean {
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
  db: EngineConnection,
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

function publishPendingResult(
  db: EngineConnection,
  placement: WorkerSessionPlacementRecord,
  row: StateDatabase["worker_workspace_pending_results"],
): void {
  publishPlacementWorkspaceResultState(db, placement.sessionId, {
    placement,
    pendingResult: pendingResultFromRow(row),
  });
  sessionChanges.emit({ agentId: placement.agentId, sessionKey: placement.sessionKey }, db);
}

export function insertWorkerWorkspacePendingResult(
  db: EngineConnection,
  claim: WorkerSessionTurnClaim,
  nowMs: number,
  gatewayInstanceId: string,
): WorkerSessionPlacementRecord {
  const placement = getRequired(db, claim.sessionId);
  const environment = resolvePlacementTurnEnvironment(placement, claim);
  if (!environment) {
    throw new Error(`Cannot retain stale worker workspace result for ${claim.sessionId}`);
  }
  const { environmentId, ownerEpoch } = environment;
  const existing = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .selectAll()
      .where("session_id", "=", claim.sessionId),
  ).rows[0];
  if (existing) {
    if (
      existing.environment_id !== environmentId ||
      existing.owner_epoch !== ownerEpoch ||
      existing.placement_generation !== claim.placementGeneration ||
      existing.claim_id !== claim.claimId ||
      existing.run_id !== claim.runId
    ) {
      throw new Error(`Worker workspace result is already pending for ${claim.sessionId}`);
    }
    // A retry retains the originally accepted authority, including a legacy mirror result.
    return placement;
  }
  const repository = findSessionRepositoryWorkspaceInDatabase(db, placement);
  const authority = repository?.diskAuthority;
  if (authority) {
    if (authority.environmentId !== environmentId) {
      throw new Error("Repository workspace result belongs to a different disk environment");
    }
    assertRepositoryWorkspaceDiskIdentity(authority, findWorkerEnvironment(db, environmentId));
  }
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("worker_workspace_pending_results")
      .values({
        session_id: claim.sessionId,
        environment_id: environmentId,
        owner_epoch: ownerEpoch,
        placement_generation: claim.placementGeneration,
        claim_id: claim.claimId,
        run_id: claim.runId,
        gateway_instance_id: gatewayInstanceId,
        recovery_requested_at_ms: null,
        workspace_accepted_at_ms: null,
        staged_result_ref: null,
        ...(authority
          ? {
              repository_workspace_id: repository.workspaceId,
              repository_disk_authority_json: JSON.stringify(authority),
            }
          : {}),
        created_at_ms: nowMs,
      })
      .returningAll(),
  );
  if (result.rows.length === 1) {
    publishPendingResult(db, placement, result.rows[0]!);
    return placement;
  }
  throw new Error(`Cannot retain worker workspace result for ${claim.sessionId}`);
}

const assertPendingClaim = (db: EngineConnection, claim: WorkerSessionTurnClaim) => {
  const placement = getRequired(db, claim.sessionId);
  const row = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_pending_results")
      .selectAll()
      .where("session_id", "=", claim.sessionId),
  ).rows[0];
  const pending = row && pendingResultFromRow(row);
  if (!row || !pending || !matchesWorkspaceResultClaim(placement, pending, claim)) {
    throw new Error(`Cannot update stale worker workspace result for ${claim.sessionId}`);
  }
  return { row, pending, placement };
};

export function recordStagedWorkerWorkspaceResult(
  db: EngineConnection,
  claim: WorkerSessionTurnClaim,
  stagedResultRef: string,
  repositoryWorkspaceId?: string,
): WorkerSessionPlacementRecord {
  if (!/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(stagedResultRef)) {
    throw new Error("Worker workspace staged result reference is invalid");
  }
  if (repositoryWorkspaceId !== undefined && !/^[a-f0-9-]{36}$/u.test(repositoryWorkspaceId)) {
    throw new Error("Worker workspace result repository identity is invalid");
  }
  if (repositoryWorkspaceId !== undefined) {
    ensureRepositoryWorkspacePendingResultSchema(db);
  }
  const { row: pending, placement } = assertPendingClaim(db, claim);
  const diskExport = pending.repository_disk_authority_json !== null;
  if (diskExport) {
    const move = readWorkerPlacementMovesReadOnly(db, [claim.sessionId]).get(claim.sessionId);
    const repository = findSessionRepositoryWorkspaceInDatabase(db, placement);
    if (
      placement.state !== "draining" ||
      move?.target.kind !== "gateway" ||
      move.abandonSource ||
      move.source.environmentId !== placement.environmentId ||
      move.source.ownerEpoch !== placement.activeOwnerEpoch ||
      move.source.generation + 1 !== placement.generation ||
      claim.claimId !== claim.runId ||
      !claim.claimId.startsWith("reclaim-") ||
      !stagedResultRef.startsWith("refs/openclaw/worker-results/gateway-export-") ||
      repositoryWorkspaceId !== pending.repository_workspace_id ||
      repository?.workspaceId !== repositoryWorkspaceId ||
      !repository.diskAuthority
    ) {
      throw new Error("A disk-authoritative result cannot stage a mirrored checkpoint");
    }
    assertRepositoryWorkspaceDiskIdentity(
      repository.diskAuthority,
      findWorkerEnvironment(db, placement.environmentId),
    );
  }
  if (pending.workspace_accepted_at_ms !== null) {
    throw new Error(`Cannot restage accepted worker workspace result for ${claim.sessionId}`);
  }
  if (
    !diskExport &&
    pending.staged_result_ref &&
    (pending.staged_result_ref !== stagedResultRef ||
      (pending.repository_workspace_id ?? undefined) !== repositoryWorkspaceId)
  ) {
    throw new Error(`Worker workspace result ref changed for ${claim.sessionId}`);
  }
  if (repositoryWorkspaceId !== undefined) {
    const repository = executeSqliteQuerySync(
      db,
      query(db)
        .selectFrom("session_repository_workspaces")
        .select(["agent_id", "session_key"])
        .where("workspace_id", "=", repositoryWorkspaceId),
    ).rows[0];
    if (
      !repository ||
      repository.agent_id !== placement.agentId ||
      repository.session_key !== placement.sessionKey
    ) {
      throw new Error(`Worker workspace result repository owner changed for ${claim.sessionId}`);
    }
  }
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_workspace_pending_results")
      .set({
        staged_result_ref: stagedResultRef,
        ...(repositoryWorkspaceId ? { repository_workspace_id: repositoryWorkspaceId } : {}),
      })
      .where("session_id", "=", claim.sessionId)
      .where("claim_id", "=", claim.claimId)
      .where("run_id", "=", claim.runId)
      .returningAll(),
  );
  if (result.rows.length !== 1) {
    throw new Error(`Cannot stage stale worker workspace result for ${claim.sessionId}`);
  }
  publishPendingResult(db, placement, result.rows[0]!);
  return placement;
}

export function listPendingWorkerWorkspaceResultsInDatabase(
  db: EngineConnection,
  sessionId?: string,
): WorkerWorkspacePendingResult[] {
  let select = query(db).selectFrom("worker_workspace_pending_results").selectAll();
  if (sessionId !== undefined) {
    select = select.where("session_id", "=", sessionId);
  }
  return executeSqliteQuerySync(db, select.orderBy("session_id")).rows.map(pendingResultFromRow);
}

export function createPlacementWorkspaceResultOps(runtime: PlacementStoreRuntime) {
  const { instanceId, now, write } = runtime;

  return {
    markWorkspaceResultPending(claim: WorkerSessionTurnClaim) {
      return write((db) => insertWorkerWorkspacePendingResult(db, claim, now(), instanceId));
    },

    acceptWorkspaceResult(claim: WorkerSessionTurnClaim) {
      return write((db) => {
        const { placement, pending } = assertPendingClaim(db, claim);
        if (pending.repositoryDiskAuthority) {
          assertRepositoryWorkspaceDiskIdentity(
            pending.repositoryDiskAuthority,
            findWorkerEnvironment(db, pending.environmentId),
          );
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_workspace_pending_results")
            .set({ workspace_accepted_at_ms: now() })
            .where("session_id", "=", claim.sessionId)
            .where("environment_id", "=", placement.environmentId)
            .where("owner_epoch", "=", placement.activeOwnerEpoch)
            .where("placement_generation", "=", claim.placementGeneration)
            .where("claim_id", "=", claim.claimId)
            .where("run_id", "=", claim.runId)
            .returningAll(),
        );
        if (result.rows.length !== 1) {
          throw new Error(`Cannot accept stale worker workspace result for ${claim.sessionId}`);
        }
        publishPendingResult(db, placement, result.rows[0]!);
        // Keep the applied journal as the crash-safe marker until this fence is
        // accepted. Recovery then inspects reality instead of replaying a result.
        clearWorkerWorkspaceReconciliation(db, claim.sessionId);
        return placement;
      });
    },

    handoffWorkspaceResultRecovery(claim: WorkerSessionTurnClaim) {
      return write((db) => {
        const { row: pending, placement } = assertPendingClaim(db, claim);
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
            .where("gateway_instance_id", "=", instanceId)
            .returningAll(),
        );
        if (result.rows.length !== 1) {
          throw new Error(`Worker workspace result changed for ${claim.sessionId}`);
        }
        publishPendingResult(db, placement, result.rows[0]!);
        return placement;
      });
    },

    abandonWorkspaceResult(pending: WorkerWorkspacePendingResult): void {
      write((db) => {
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
        publishPlacementWorkspaceResultState(db, pending.sessionId, null);
        sessionChanges.emit({ all: true, scope: "worker-placements" }, db);
      });
    },
  };
}
