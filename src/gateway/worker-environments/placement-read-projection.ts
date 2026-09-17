import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type { WorkerEnvironmentPlacementFacts } from "./environment-record.js";
import {
  readWorkerPlacementMovesInDatabase,
  ensureExistingWorkerPlacementMoveSchema,
  type WorkerPlacementMoveIntent,
} from "./placement-move-intent.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import { readWorkerSessionPlacementsInDatabase } from "./placement-row-codec.js";
import {
  hasCurrentWorkspaceResultClaim,
  readWorkerWorkspaceReconcilingSessionIds,
} from "./placement-workspace-result.js";
import { decodeRow as decodeWorkerEnvironmentRow } from "./store.js";

export type WorkerSessionPlacementProjection = {
  placements: ReadonlyMap<string, WorkerSessionPlacementRecord>;
  moves: ReadonlyMap<string, WorkerPlacementMoveIntent>;
  workspaceResultReconcilingSessionIds: ReadonlySet<string>;
  environments: ReadonlyMap<string, WorkerEnvironmentPlacementFacts>;
};

export type WorkerPlacementConflictBinding = {
  placement: Pick<
    WorkerSessionPlacementRecord,
    "sessionId" | "generation" | "environmentId" | "activeOwnerEpoch"
  >;
  claim: WorkerSessionTurnClaim;
};

export function readWorkerSessionPlacementProjectionInDatabase(
  db: DatabaseSync,
  sessionIds: readonly string[],
  conflictBindings: readonly WorkerPlacementConflictBinding[],
): { projection: WorkerSessionPlacementProjection; conflictSessionIds: ReadonlySet<string> } {
  // Additive move-schema preparation must finish before the read snapshot starts.
  ensureExistingWorkerPlacementMoveSchema(db);
  return runSqliteDeferredTransactionSync(db, () => {
    const placements = readWorkerSessionPlacementsInDatabase(db, sessionIds);
    const projection: WorkerSessionPlacementProjection = {
      placements,
      moves: readWorkerPlacementMovesInDatabase(db, sessionIds),
      workspaceResultReconcilingSessionIds: readWorkerWorkspaceReconcilingSessionIds(
        db,
        sessionIds,
      ),
      environments: readWorkerEnvironmentPlacementFactsInDatabase(
        db,
        [...placements.values()].flatMap((record) =>
          record.environmentId ? [record.environmentId] : [],
        ),
      ),
    };
    const conflictSessionIds = new Set<string>();
    for (const binding of conflictBindings) {
      const record = placements.get(binding.placement.sessionId);
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

function readWorkerEnvironmentPlacementFactsInDatabase(
  db: DatabaseSync,
  environmentIds: readonly string[],
): ReadonlyMap<string, WorkerEnvironmentPlacementFacts> {
  const records = new Map<string, WorkerEnvironmentPlacementFacts>();
  const ids = [...new Set(environmentIds)];
  for (let offset = 0; offset < ids.length; offset += 250) {
    const rows = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<StateDatabase, "worker_environments">>(db)
        .selectFrom("worker_environments")
        .selectAll()
        .where("environment_id", "in", ids.slice(offset, offset + 250)),
    ).rows;
    for (const row of rows) {
      const record = decodeWorkerEnvironmentRow(row, []);
      records.set(record.environmentId, {
        environmentId: record.environmentId,
        providerId: record.providerId,
        profileId: record.profileId,
        profileSnapshot: record.profileSnapshot,
        state: record.state,
        leaseId: record.leaseId,
        ownerEpoch: record.ownerEpoch,
        nodeDeviceId: record.nodeDeviceId,
        attachedSessionIds: record.attachedSessionIds,
      });
    }
  }
  return records;
}
