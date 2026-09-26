import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createWorkerInferenceStoreKernel } from "./inference-store.kernel.js";
import type { WorkerInferenceStoreOperations } from "./inference-store.worker-contract.js";

export function executeWorkerInferenceStoreCommand(
  command: SqliteWorkerCommand<WorkerInferenceStoreOperations>,
  database: OpenClawStateDatabase,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const store = createWorkerInferenceStoreKernel({
        db,
        now: () => command.input.nowMs,
        retention: command.input.retention,
      });
      const result = (() => {
        switch (command.type) {
          case "workerInference.begin":
            return store.begin(command.input.input);
          case "workerInference.complete":
            return store.complete(command.input.input);
          case "workerInference.cancelPending":
            return store.cancelPending(command.input.input);
          case "workerInference.recoverPending":
            return store.recoverPending(command.input.input);
        }
      })();
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database },
    { operationLabel: command.type },
  );
}
