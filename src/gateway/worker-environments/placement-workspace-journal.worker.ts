import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createPlacementWorkspaceJournalOps } from "./placement-workspace-journal.js";
import type {
  WorkspaceJournalReceipt,
  WorkspaceJournalWorkerOperations,
} from "./placement-workspace-journal.worker-contract.js";

export function executeWorkspaceJournalCommand(
  command: SqliteWorkerCommand<WorkspaceJournalWorkerOperations>,
  database: OpenClawStateDatabase,
): WorkspaceJournalReceipt {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const journal = createPlacementWorkspaceJournalOps({
        now: () =>
          command.type === "placementJournals.begin"
            ? (command.input.nowMs ?? Date.now())
            : Date.now(),
        write: (operation) => operation(db),
      });
      const mutation =
        command.type === "placementJournals.begin"
          ? journal.beginWorkspaceReconciliation(command.input.owner, command.input.journal)
          : command.type === "placementJournals.abort"
            ? journal.abortWorkspaceReconciliation(command.input.owner, {
                force: command.input.force,
              })
            : journal.pruneOrphanedWorkspaceReconciliations();
      const receipt: WorkspaceJournalReceipt = { type: command.type, ...mutation };
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    },
    { database },
    { operationLabel: command.type },
  );
}
