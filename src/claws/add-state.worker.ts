import { mergeWorkspaceSetupStateInDatabase } from "../agents/workspace-state-store.worker.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { ClawAddStateCommand } from "./add-state-worker-contract.js";

/** One finite Claw Add state change runs entirely on the shared SQLite actor. */
export function executeClawAddStateCommand(
  command: ClawAddStateCommand,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    () => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = mergeWorkspaceSetupStateInDatabase(
        database,
        command.input.workspaceDir,
        { bootstrapSeededAt: command.input.bootstrapSeededAt },
        command.input.nowMs,
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database },
  );
}
