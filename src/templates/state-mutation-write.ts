import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { runWithOpenClawStateLeasesWorker } from "../state/openclaw-state-lease-worker-operation.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { TemplateAddStateWorkerOperations } from "./add-state-worker-contract.js";
import type { TemplateMutationStateOptions } from "./state-mutation-options.js";

export type { TemplateMutationStateOptions } from "./state-mutation-options.js";

export async function executeTemplateMutationStateCommand<
  Key extends keyof TemplateAddStateWorkerOperations,
>(
  options: TemplateMutationStateOptions,
  command: { type: Key; input: Omit<TemplateAddStateWorkerOperations[Key]["input"], "leases"> },
): Promise<TemplateAddStateWorkerOperations[Key]["output"]> {
  if (options.database) {
    throw new Error("Worker-mode Template lifecycle cannot use a caller-owned database handle.");
  }
  const context = options.leaseSet?.context ?? captureOpenClawStateWorkerContext(options);
  const assertCurrent = options.assertCurrent;
  await options.prepareEffect?.();
  if (options.leaseSet) {
    return runWithOpenClawStateLeasesWorker(
      options.leaseSet.leases,
      context,
      (scope, leases) => scope.execute({ ...command, input: { ...command.input, leases } }),
      { assertCurrent: () => assertCurrent?.() },
    );
  }
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage !== "transaction" && request.stage !== "commit") {
          throw new Error("Template lifecycle state writes require transaction admission.");
        }
        context.admission.assertCurrent();
        assertCurrent?.();
        grant();
      }),
    }),
  });
}
