import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { workerInferenceMetadata } from "./inference-placement.js";
import { readWorkerPlacementMovesReadOnly } from "./placement-move-intent.js";
import type {
  WorkerEnvironmentPlacementFacts,
  WorkerPlacementConflictBinding,
  WorkerPlacementRecoveryCandidate,
  WorkerSessionPlacementProjection,
  WorkerSessionPlacementReadResult,
} from "./placement-read-projection.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { fromRow } from "./placement-row-codec.js";
import { parseWorkerSessionPlacementState } from "./placement-state.js";
import { isCurrentJournalOwner } from "./placement-workspace-journal.js";
import {
  hasCurrentWorkspaceResultClaim,
  readWorkerWorkspaceReconciliationFacts,
} from "./placement-workspace-result.js";
import { decodeWorkerEnvironmentRow } from "./store-row-codec.js";

export function readWorkerPlacementEnvironmentOwnerInDatabase(
  db: DatabaseSync,
  environmentId: string,
): WorkerSessionPlacementRecord | undefined {
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<StateDatabase>(db)
      .selectFrom("worker_session_placements")
      .selectAll()
      .where("environment_id", "=", environmentId)
      .limit(2),
  ).rows;
  if (rows.length > 1) {
    throw new Error(`Worker environment ${environmentId} has multiple placement owners`);
  }
  return rows[0] ? fromRow(rows[0]) : undefined;
}

export function readWorkerSessionPlacementProjectionInDatabase(
  db: DatabaseSync,
  sessionIds: readonly string[],
  conflictBindings: readonly WorkerPlacementConflictBinding[],
): WorkerSessionPlacementReadResult {
  return runSqliteDeferredTransactionSync(db, () => {
    const { placements, reconcilingSessionIds, pendingResults } =
      readWorkerWorkspaceReconciliationFacts(db, sessionIds);
    const workspaceRecoveryPendingSessionIds = new Set(pendingResults.keys());
    const workspaceJournalOwnerSessionIds = new Set<string>();
    for (let offset = 0; offset < sessionIds.length; offset += 250) {
      for (const row of executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<StateDatabase, "worker_workspace_reconciliations">>(db)
          .selectFrom("worker_workspace_reconciliations")
          .select(["session_id", "environment_id", "owner_epoch", "placement_generation"])
          .where("session_id", "in", sessionIds.slice(offset, offset + 250)),
      ).rows) {
        workspaceRecoveryPendingSessionIds.add(row.session_id);
        if (
          isCurrentJournalOwner(db, placements.get(row.session_id), {
            sessionId: row.session_id,
            environmentId: row.environment_id,
            ownerEpoch: row.owner_epoch,
            placementGeneration: row.placement_generation,
          })
        ) {
          workspaceJournalOwnerSessionIds.add(row.session_id);
        }
      }
    }
    const environments = new Map<string, WorkerEnvironmentPlacementFacts>();
    const environmentIds = [
      ...new Set(
        [...placements.values()].flatMap((placement) =>
          placement.environmentId ? [placement.environmentId] : [],
        ),
      ),
    ];
    for (let offset = 0; offset < environmentIds.length; offset += 250) {
      for (const row of executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<StateDatabase, "worker_environments">>(db)
          .selectFrom("worker_environments")
          .selectAll()
          .where("environment_id", "in", environmentIds.slice(offset, offset + 250)),
      ).rows) {
        const record = decodeWorkerEnvironmentRow(row, []);
        environments.set(record.environmentId, {
          environmentId: record.environmentId,
          providerId: record.providerId,
          profileId: record.profileId,
          profileSnapshot: record.profileSnapshot,
          ...workerInferenceMetadata(record),
          state: record.state,
          leaseId: record.leaseId,
          ownerEpoch: record.ownerEpoch,
          nodeDeviceId: record.nodeDeviceId,
          attachedSessionIds: record.attachedSessionIds,
        });
      }
    }
    const projection: WorkerSessionPlacementProjection = {
      placements,
      moves: readWorkerPlacementMovesReadOnly(db, sessionIds),
      pendingResults,
      workspaceJournalOwnerSessionIds,
      workspaceResultReconcilingSessionIds: reconcilingSessionIds,
      workspaceRecoveryPendingSessionIds,
      environments,
    };
    const conflictSessionIds = new Set<string>();
    for (const binding of conflictBindings) {
      const record = placements.get(binding.placement.sessionId);
      // Host-only conflict payloads belong to the captured placement or its retained result claim.
      if (
        record &&
        record.environmentId === binding.placement.environmentId &&
        record.activeOwnerEpoch === binding.placement.activeOwnerEpoch &&
        (record.generation === binding.placement.generation ||
          hasCurrentWorkspaceResultClaim(db, binding.claim))
      ) {
        conflictSessionIds.add(record.sessionId);
      }
    }
    return { projection, conflictSessionIds };
  });
}

export function readWorkerPlacementRecoveryCandidatesInDatabase(
  db: DatabaseSync,
): WorkerPlacementRecoveryCandidate[] {
  return runSqliteDeferredTransactionSync(db, () => {
    const query = getNodeSqliteKysely<StateDatabase>(db);
    const placements = new Map(
      executeSqliteQuerySync(
        db,
        query
          .selectFrom("worker_session_placements")
          .select(["session_id", "environment_id", "state"])
          .orderBy("updated_at_ms")
          .orderBy("session_id"),
      ).rows.map((row) => [
        row.session_id,
        {
          sessionId: row.session_id,
          environmentId: row.environment_id,
          state: parseWorkerSessionPlacementState(row.state),
        },
      ]),
    );
    const candidates = new Map<string, WorkerPlacementRecoveryCandidate>(
      [...placements].filter(
        ([, placement]) => placement.state !== "local" && placement.state !== "reclaimed",
      ),
    );
    const add = (sessionId: string): WorkerPlacementRecoveryCandidate => {
      const candidate = candidates.get(sessionId) ??
        placements.get(sessionId) ?? { sessionId, environmentId: null };
      candidates.set(sessionId, candidate);
      return candidate;
    };
    if (tableExists(db, "worker_session_placement_moves")) {
      for (const row of executeSqliteQuerySync(
        db,
        query
          .selectFrom("worker_session_placement_moves")
          .select(["session_id", "source_environment_id"])
          .orderBy("created_at_ms")
          .orderBy("session_id"),
      ).rows) {
        add(row.session_id).moveSourceEnvironmentId = row.source_environment_id;
      }
    }
    for (const table of [
      "worker_workspace_pending_results",
      "worker_workspace_reconciliations",
    ] as const) {
      for (const row of executeSqliteQuerySync(
        db,
        query.selectFrom(table).select("session_id").orderBy("session_id"),
      ).rows) {
        add(row.session_id);
      }
    }
    return [...candidates.values()];
  });
}
