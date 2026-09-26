import { hasLocalWorkspaceProjectionInDatabase } from "../../gateway/worker-environments/local-workspace-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  getRegistryWorktreeInDatabase,
  rowToRecord,
  WORKTREE_RECORD_COLUMNS,
  worktreeGcRevision,
} from "./registry-read.kernel.js";
import type { ManagedWorktreeRecord } from "./types.js";

export type WorktreeRetirementOperations = {
  "worktrees.deferCleanup": {
    input: { observed: ManagedWorktreeRecord; reason: string | null };
    output: boolean;
  };
  "worktrees.retireMissing": {
    input: {
      observed: Pick<
        ManagedWorktreeRecord,
        "id" | "path" | "lastActiveAt" | "repoRoot" | "repoFingerprint"
      >;
      removedAt: number;
    };
    output: { record?: ManagedWorktreeRecord; protection?: "local-workspace-projection" };
  };
};

export function deferWorktreeCleanupInWorker(
  { observed, reason }: WorktreeRetirementOperations["worktrees.deferCleanup"]["input"],
  options: OpenClawStateDatabaseOptions,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const current = getRegistryWorktreeInDatabase(db, observed.id);
      const revision = worktreeGcRevision(observed);
      if (!current || current.removedAt !== undefined || worktreeGcRevision(current) !== revision) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
          .updateTable("worktrees")
          .set({
            gc_protection_json: reason === null ? null : JSON.stringify({ revision, reason }),
          })
          .where("id", "=", observed.id),
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return true;
    },
    options,
    { operationLabel: "worktrees.deferCleanup" },
  );
}

export function retireMissingWorktreeInWorker(
  { observed, removedAt }: WorktreeRetirementOperations["worktrees.retireMissing"]["input"],
  options: OpenClawStateDatabaseOptions,
): WorktreeRetirementOperations["worktrees.retireMissing"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      // Projection creation checks the live registry in its own write transaction.
      // Whichever writer commits first fences the other, including unfinished preparation.
      if (hasLocalWorkspaceProjectionInDatabase(db, observed.id)) {
        return {
          record: getRegistryWorktreeInDatabase(db, observed.id),
          protection: "local-workspace-projection",
        };
      }
      // A path probe cannot retire a restored lifecycle or a rebound repository.
      const retired = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
          .updateTable("worktrees")
          .set({ removed_at: removedAt })
          .where("id", "=", observed.id)
          .where("removed_at", "is", null)
          // A private exact-state retirement path may still hold the complete
          // source. Only its explicit recovery owner can finalize that lifecycle.
          .where((eb) =>
            eb.or([
              eb("snapshot_ref", "is", null),
              eb("snapshot_ref", "not like", "refs/openclaw/snapshots/exact-%"),
            ]),
          )
          .where("path", "=", observed.path)
          .where("last_active_at", "=", observed.lastActiveAt)
          .where("repo_root", "=", observed.repoRoot)
          .where("repo_fingerprint", "=", observed.repoFingerprint)
          .returning(WORKTREE_RECORD_COLUMNS),
      ).rows[0];
      const current =
        retired ??
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "worktrees">>(db)
            .selectFrom("worktrees")
            .select(WORKTREE_RECORD_COLUMNS)
            .where("id", "=", observed.id),
        ).rows[0];

      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return { record: current ? rowToRecord(current) : undefined };
    },
    options,
    { operationLabel: "worktrees.retireMissing" },
  );
}
