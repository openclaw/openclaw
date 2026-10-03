import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";

export function worktreeTemplateMutation<Input, Output>(
  operationLabel: string,
  mutate: (env: NodeJS.ProcessEnv, input: Input, commitGuard: () => void) => Output,
) {
  return (input: Input, context: WorkerOperationContext): Output => {
    const database = context.open();
    const options = context.stateOptions();
    return runOpenClawStateWriteTransaction(
      () => {
        const result = mutate(options.env, input, () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        });
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { ...options, database },
      { operationLabel },
    );
  };
}
