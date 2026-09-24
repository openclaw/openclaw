import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";

export async function releaseWorktreeRunLeaseRowAsync(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext({ env }),
): Promise<void> {
  await runLeaseCommand(context, {
    type: "worktrees.releaseRunLease",
    input: { worktreeId, token },
  });
}

export async function reapWorktreeRunLeases(
  env: NodeJS.ProcessEnv,
  scopes: string[],
): Promise<void> {
  if (scopes.length > 0) {
    await runLeaseCommand(captureOpenClawStateWorkerContext({ env }), {
      type: "worktrees.reapRunLeases",
      input: { scopes },
    });
  }
}

async function runLeaseCommand(
  context: OpenClawStateWorkerContext,
  command: SqliteWorkerCommand<
    Pick<OpenClawStateWorkerOperations, "worktrees.releaseRunLease" | "worktrees.reapRunLeases">
  >,
): Promise<void> {
  const { runOpenClawStateWorkerOperation } =
    await import("../../state/openclaw-state-worker-store.js");
  await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((_request, grant) => {
        context.admission.assertCurrent();
        grant();
      }),
    }),
  });
}
