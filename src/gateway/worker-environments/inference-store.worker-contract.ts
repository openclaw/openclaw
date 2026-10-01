import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type {
  createWorkerInferenceStoreKernel,
  WorkerInferenceRetentionPolicy,
} from "./inference-store.kernel.js";

type Kernel = ReturnType<typeof createWorkerInferenceStoreKernel>;

export type WorkerInferenceStoreOperations = {
  [Method in keyof Kernel as `workerInference.${Method}`]: {
    input: {
      input: Parameters<Kernel[Method]>[0];
      nowMs: number;
      retention: Partial<WorkerInferenceRetentionPolicy>;
    };
    output: ReturnType<Kernel[Method]>;
  };
};

export function isWorkerInferenceStoreCommand(command: {
  type: PropertyKey;
}): command is SqliteWorkerCommand<WorkerInferenceStoreOperations> {
  return (
    command.type === "workerInference.begin" ||
    command.type === "workerInference.complete" ||
    command.type === "workerInference.cancelPending" ||
    command.type === "workerInference.recoverPending"
  );
}
