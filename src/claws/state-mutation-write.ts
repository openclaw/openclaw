import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { ClawMutationStateOptions } from "./state-mutation-options.js";

export type { ClawMutationStateOptions } from "./state-mutation-options.js";

export async function executeClawMutationStateCommand<
  Key extends keyof OpenClawStateWorkerOperations,
>(
  options: ClawMutationStateOptions,
  command: { type: Key; input: OpenClawStateWorkerOperations[Key]["input"] },
): Promise<OpenClawStateWorkerOperations[Key]["output"]> {
  if (options.database) {
    throw new Error("Worker-mode Claw lifecycle cannot use a caller-owned database handle.");
  }
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = options.assertCurrent;
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage !== "transaction" && request.stage !== "commit") {
          throw new Error("Claw lifecycle state writes require transaction admission.");
        }
        context.admission.assertCurrent();
        assertCurrent?.();
        grant();
      }),
    }),
  });
}
