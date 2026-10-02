import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { createWorkerInferenceStoreKernel } from "./inference-store.kernel.js";
import type { WorkerInferenceRetentionPolicy } from "./inference-store.types.js";

type Kernel = ReturnType<typeof createWorkerInferenceStoreKernel>;

function operation<Input, Output>(
  type: string,
  select: (store: Kernel) => (input: Input) => Output,
) {
  return (
    input: { input: Input; nowMs: number; retention: Partial<WorkerInferenceRetentionPolicy> },
    { open }: WorkerOperationContext,
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const store = createWorkerInferenceStoreKernel({
          db,
          now: () => input.nowMs,
          retention: input.retention,
        });
        const result = select(store)(input.input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { database: open() },
      { operationLabel: type },
    );
}

export const workerInferenceOperations = {
  "workerInference.begin": operation("workerInference.begin", (store) => store.begin),
  "workerInference.complete": operation("workerInference.complete", (store) => store.complete),
  "workerInference.cancelPending": operation(
    "workerInference.cancelPending",
    (store) => store.cancelPending,
  ),
  "workerInference.recoverPending": operation(
    "workerInference.recoverPending",
    (store) => store.recoverPending,
  ),
} satisfies WorkerOperationHandlers;
