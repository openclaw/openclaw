import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { reapWorktreeRunLeasesInDatabase } from "./run-lease-owner.js";
import { releaseWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";

export function executeWorktreeRunLeaseCommand(
  command: SqliteWorkerCommand<
    Pick<OpenClawStateWorkerOperations, "worktrees.releaseRunLease" | "worktrees.reapRunLeases">
  >,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      if (command.type === "worktrees.reapRunLeases") {
        reapWorktreeRunLeasesInDatabase(db, command.input.scopes);
      } else {
        releaseWorktreeRunLeaseInDatabase(db, command.input.worktreeId, command.input.token);
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    },
    options,
    { operationLabel: command.type },
  );
}
