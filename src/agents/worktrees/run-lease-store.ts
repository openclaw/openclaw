import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

export async function releaseWorktreeRunLeaseRowAsync(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext({ env }),
): Promise<void> {
  const { runOpenClawStateWorkerOperation } =
    await import("../../state/openclaw-state-worker-store.js");
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "worktrees.releaseRunLease", input: { worktreeId, token } }),
    {
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((_request, grant) => {
          context.admission.assertCurrent();
          grant();
        }),
      }),
    },
  );
}
