import type { DatabaseSync } from "node:sqlite";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";

export function worktreeRunLeaseOperation<Input>(
  operationLabel: string,
  mutate: (database: DatabaseSync, input: Input) => void,
) {
  return (input: Input, context: WorkerOperationContext): void => {
    const database = context.open();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        mutate(db, input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      },
      { ...context.stateOptions(), database },
      { operationLabel },
    );
  };
}
