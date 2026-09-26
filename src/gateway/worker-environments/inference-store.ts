import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type {
  createWorkerInferenceStoreKernel,
  WorkerInferenceRetentionPolicy,
} from "./inference-store.kernel.js";
import type { WorkerInferenceStoreOperations } from "./inference-store.worker-contract.js";

export type { WorkerInferenceTurnInput } from "./inference-store.kernel.js";

type Kernel = ReturnType<typeof createWorkerInferenceStoreKernel>;
type Operations = WorkerInferenceStoreOperations;

export function createWorkerInferenceStore(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    retention?: Partial<WorkerInferenceRetentionPolicy>;
  } = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const now = options.now ?? Date.now;
  const retention = { ...options.retention };
  const execute = <Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    assertCurrent?: () => void,
  ): Promise<Operations[Key]["output"]> => {
    const captured = structuredClone(command);
    const check = () => {
      context.admission.assertCurrent();
      assertCurrent?.();
    };
    return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(captured), {
      assertCurrent: check,
      createAdmission: createSqliteWorkerWriteAdmission(check, [context.admission.databasePath]),
    });
  };
  const prepare = <Input>(input: Input) => ({ input, nowMs: now(), retention });
  return {
    begin: (input: Parameters<Kernel["begin"]>[0], assertCurrent?: () => void) =>
      execute({ type: "workerInference.begin", input: prepare(input) }, assertCurrent),
    complete: (input: Parameters<Kernel["complete"]>[0], assertCurrent?: () => void) =>
      execute({ type: "workerInference.complete", input: prepare(input) }, assertCurrent),
    cancelPending: (input: Parameters<Kernel["cancelPending"]>[0], assertCurrent?: () => void) =>
      execute({ type: "workerInference.cancelPending", input: prepare(input) }, assertCurrent),
    recoverPending: (input: Parameters<Kernel["recoverPending"]>[0], assertCurrent?: () => void) =>
      execute({ type: "workerInference.recoverPending", input: prepare(input) }, assertCurrent),
  };
}

export type WorkerInferenceStore = ReturnType<typeof createWorkerInferenceStore>;
