import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";

export function writeProvisionedSnapshotInWorker(
  input: { worktreeId: string } & (
    | { kind: "reset" }
    | { kind: "chunk"; path: string; chunkIndex: number; data: Uint8Array }
  ),
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const kysely = getNodeSqliteKysely<Pick<DB, "worktree_provisioned_file_chunks">>(db);
      if (input.kind === "reset") {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("worktree_provisioned_file_chunks")
            .where("worktree_id", "=", input.worktreeId),
        );
      } else {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("worktree_provisioned_file_chunks").values({
            worktree_id: input.worktreeId,
            path: input.path,
            chunk_index: input.chunkIndex,
            data: input.data,
          }),
        );
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    },
    options,
    { operationLabel: "worktrees.writeProvisionedSnapshot" },
  );
}
