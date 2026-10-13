import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  FORCED_WORKER_ABANDONMENT_ERROR,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";
import { find, getRequired } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { publishPlacementWorkspaceJournalState } from "./placement-turn-authority.js";
import type {
  WorkerWorkspaceJournalOwner,
  WorkspaceJournalChange,
  WorkspaceJournalMutation,
  WorkspaceJournalReadCommand,
  WorkspaceJournalReadResult,
} from "./placement-workspace-journal.types.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";
import { MAX_RECONCILIATION_PACK_BYTES } from "./workspace-manifest.js";
import {
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";

type WorkspaceJournalDatabase = Pick<
  StateDatabase,
  | "worker_session_placements"
  | "worker_workspace_pending_results"
  | "worker_workspace_reconciliations"
>;

const query = (db: DatabaseSync) => getNodeSqliteKysely<WorkspaceJournalDatabase>(db);

export function isCurrentJournalOwner(
  db: DatabaseSync,
  placement: WorkerSessionPlacementRecord | undefined,
  owner: WorkerWorkspaceJournalOwner,
  pendingResults?: ReadonlyMap<string, WorkerWorkspacePendingResult>,
): placement is Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }> {
  if (
    (placement?.state !== "active" && placement?.state !== "draining") ||
    placement.environmentId !== owner.environmentId ||
    placement.activeOwnerEpoch !== owner.ownerEpoch
  ) {
    return false;
  }
  if (placement.generation === owner.placementGeneration) {
    return true;
  }
  if (placement.state !== "draining" || placement.generation !== owner.placementGeneration + 1) {
    return false;
  }
  // A pending result retains its original active generation while a lifecycle
  // drain closes admission. That exact durable fence alone may keep the older
  // journal owner valid through the one-generation drain transition.
  // Projection callers supply pending facts from the placement's own read snapshot.
  const pending = pendingResults
    ? pendingResults.get(owner.sessionId)
    : executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_workspace_pending_results")
          .select([
            "environment_id as environmentId",
            "owner_epoch as ownerEpoch",
            "placement_generation as placementGeneration",
          ])
          .where("session_id", "=", owner.sessionId),
      ).rows[0];
  return (
    pending?.environmentId === owner.environmentId &&
    pending.ownerEpoch === owner.ownerEpoch &&
    pending.placementGeneration === owner.placementGeneration
  );
}

function assertJournalOwner(
  db: DatabaseSync,
  owner: WorkerWorkspaceJournalOwner,
  options: { allowFailedOwner?: boolean } = {},
) {
  const placement = getRequired(db, owner.sessionId);
  const isCurrentOwner = isCurrentJournalOwner(db, placement, owner);
  // Forced teardown advances the exact owner to failed before best-effort
  // rollback. Admit that state without weakening the manifest checks below.
  const isAllowedFailedOwner =
    options.allowFailedOwner === true &&
    placement.state === "failed" &&
    placement.generation > owner.placementGeneration &&
    placement.environmentId === owner.environmentId &&
    placement.activeOwnerEpoch === owner.ownerEpoch;
  if (!isCurrentOwner && !isAllowedFailedOwner) {
    throw new Error(`Cannot reconcile stale worker workspace for session ${owner.sessionId}`);
  }
  return placement;
}

export function clearWorkerWorkspaceReconciliation(
  db: DatabaseSync,
  sessionId: string,
  currentManifestRef?: string,
): void {
  const existing = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_reconciliations")
      .select("current_manifest_ref")
      .where("session_id", "=", sessionId),
  ).rows[0];
  if (existing && currentManifestRef && existing.current_manifest_ref !== currentManifestRef) {
    throw new Error(`Worker workspace journal result changed for session ${sessionId}`);
  }
  executeSqliteQuerySync(
    db,
    query(db).deleteFrom("worker_workspace_reconciliations").where("session_id", "=", sessionId),
  );
  publishPlacementWorkspaceJournalState(db, sessionId, false);
}

function getWorkspaceReconciliationPlacement(db: DatabaseSync, owner: WorkerWorkspaceJournalOwner) {
  const placement = find(db, owner.sessionId);
  return isCurrentJournalOwner(db, placement, owner) ? placement : undefined;
}

function listWorkspaceReconciliationOwners(db: DatabaseSync): WorkerWorkspaceJournalOwner[] {
  return executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_reconciliations")
      .select(["session_id", "environment_id", "owner_epoch", "placement_generation"])
      .orderBy("session_id"),
  ).rows.map((row) => ({
    sessionId: row.session_id,
    environmentId: row.environment_id,
    ownerEpoch: row.owner_epoch,
    placementGeneration: row.placement_generation,
  }));
}

function loadWorkspaceReconciliation(
  db: DatabaseSync,
  owner: WorkerWorkspaceJournalOwner,
  options: { allowFailedOwner?: boolean } = {},
): WorkerWorkspaceReconciliationJournal | undefined {
  const placement = assertJournalOwner(db, owner, options);
  const row = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_workspace_reconciliations")
      .selectAll()
      .where("session_id", "=", owner.sessionId),
  ).rows[0];
  if (!row) {
    return undefined;
  }
  const plan = parseWorkerWorkspaceReconciliationPlan(row.plan_json);
  if (
    row.environment_id !== owner.environmentId ||
    row.owner_epoch !== owner.ownerEpoch ||
    row.placement_generation !== owner.placementGeneration ||
    (placement.workspaceBaseManifestRef !== row.base_manifest_ref &&
      placement.workspaceBaseManifestRef !== plan.appliedManifestRef)
  ) {
    throw new Error(`Worker workspace journal owner is stale for session ${owner.sessionId}`);
  }
  if (
    plan.baseManifestRef !== row.base_manifest_ref ||
    plan.currentManifestRef !== row.current_manifest_ref
  ) {
    throw new Error(`Worker workspace journal metadata is inconsistent for ${owner.sessionId}`);
  }
  if (
    row.base_pack.byteLength > MAX_RECONCILIATION_PACK_BYTES ||
    createHash("sha256").update(row.base_pack).digest("hex") !== plan.basePackSha256
  ) {
    throw new Error(`Worker workspace journal snapshot is invalid for ${owner.sessionId}`);
  }
  return { ...plan, basePack: row.base_pack };
}

export function createPlacementWorkspaceJournalOps(
  runtime: Pick<PlacementStoreRuntime, "now" | "write">,
) {
  const { now, write } = runtime;
  return {
    pruneOrphanedWorkspaceReconciliations(): WorkspaceJournalMutation {
      return write((db) => {
        const pruned: WorkerWorkspaceJournalOwner[] = [];
        const changes: WorkspaceJournalChange[] = [];
        for (const owner of listWorkspaceReconciliationOwners(db)) {
          const placement = find(db, owner.sessionId);
          const stillOwned = isCurrentJournalOwner(db, placement, owner);
          const retainedFailedOwner =
            placement?.state === "failed" &&
            placement.environmentId === owner.environmentId &&
            placement.activeOwnerEpoch === owner.ownerEpoch &&
            placement.generation > owner.placementGeneration &&
            placement.recoveryError.startsWith(FORCED_WORKER_ABANDONMENT_ERROR);
          if (stillOwned || retainedFailedOwner) {
            continue;
          }
          // Generation and owner epoch only advance, so a mismatched exact owner cannot rebind.
          const deleted = executeSqliteQuerySync(
            db,
            query(db)
              .deleteFrom("worker_workspace_reconciliations")
              .where("session_id", "=", owner.sessionId)
              .where("environment_id", "=", owner.environmentId)
              .where("owner_epoch", "=", owner.ownerEpoch)
              .where("placement_generation", "=", owner.placementGeneration),
          );
          if (deleted.numAffectedRows === 1n) {
            publishPlacementWorkspaceJournalState(db, owner.sessionId, false);
            pruned.push(owner);
            if (placement) {
              const change = { agentId: placement.agentId, sessionKey: placement.sessionKey };
              changes.push(change);
              sessionChanges.emit(change, db);
            }
          }
        }
        return { owners: pruned, changes };
      });
    },

    beginWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      journal: WorkerWorkspaceReconciliationJournal,
    ): WorkspaceJournalMutation {
      if (journal.appliedManifestRef) {
        throw new Error("Worker workspace reconciliation cannot begin as already applied");
      }
      return write((db) => {
        const placement = assertJournalOwner(db, owner);
        if (placement.workspaceBaseManifestRef !== journal.baseManifestRef) {
          throw new Error(`Worker workspace base changed for session ${owner.sessionId}`);
        }
        const inserted = executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_workspace_reconciliations")
            .values({
              session_id: owner.sessionId,
              environment_id: owner.environmentId,
              owner_epoch: owner.ownerEpoch,
              placement_generation: owner.placementGeneration,
              base_manifest_ref: journal.baseManifestRef,
              current_manifest_ref: journal.currentManifestRef,
              plan_json: serializeWorkerWorkspaceReconciliationPlan(journal),
              base_pack: journal.basePack,
              created_at_ms: now(),
            })
            .onConflict((conflict) => conflict.column("session_id").doNothing()),
        );
        if (inserted.numAffectedRows !== 1n) {
          throw new Error(
            `Worker workspace reconciliation is already pending for ${owner.sessionId}`,
          );
        }
        publishPlacementWorkspaceJournalState(db, owner.sessionId, true);
        const change = { agentId: placement.agentId, sessionKey: placement.sessionKey };
        sessionChanges.emit(change, db);
        return { owners: [owner], changes: [change] };
      });
    },

    abortWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      options: { force?: boolean } = {},
    ): WorkspaceJournalMutation {
      return write((db) => {
        if (!options.force) {
          const placement = assertJournalOwner(db, owner);
          clearWorkerWorkspaceReconciliation(db, owner.sessionId);
          const change = { agentId: placement.agentId, sessionKey: placement.sessionKey };
          sessionChanges.emit(change, db);
          return { owners: [owner], changes: [change] };
        }
        // Forced teardown owns this exact durable journal even when placement
        // state advanced after a failed recovery sweep.
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .deleteFrom("worker_workspace_reconciliations")
            .where("session_id", "=", owner.sessionId)
            .where("environment_id", "=", owner.environmentId)
            .where("owner_epoch", "=", owner.ownerEpoch)
            .where("placement_generation", "=", owner.placementGeneration),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker workspace journal changed for ${owner.sessionId}`);
        }
        publishPlacementWorkspaceJournalState(db, owner.sessionId, false);
        const change: WorkspaceJournalChange = { all: true, scope: "worker-placements" };
        sessionChanges.emit(change, db);
        return { owners: [owner], changes: [change] };
      });
    },
  };
}

export function readWorkspaceJournalInDatabase(
  db: DatabaseSync,
  command: WorkspaceJournalReadCommand,
): WorkspaceJournalReadResult {
  return runSqliteDeferredTransactionSync(db, () => {
    if (command.type === "placementJournals.owners") {
      return { type: command.type, owners: listWorkspaceReconciliationOwners(db) };
    }
    if (command.type === "placementJournals.placement") {
      return {
        type: command.type,
        placement: getWorkspaceReconciliationPlacement(db, command.owner),
      };
    }
    return {
      type: command.type,
      journal: loadWorkspaceReconciliation(db, command.owner, {
        allowFailedOwner: command.allowFailedOwner,
      }),
    };
  });
}
