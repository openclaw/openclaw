import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { WorktreeRetirementOperations } from "./registry-retirement.worker.js";

export async function deferWorktreeCleanup(
  env: NodeJS.ProcessEnv,
  input: WorktreeRetirementOperations["worktrees.deferCleanup"]["input"],
) {
  return await mutateCleanupRecord(env, { type: "worktrees.deferCleanup", input });
}

export async function retireMissingRegistryWorktree(
  env: NodeJS.ProcessEnv,
  observed: WorktreeRetirementOperations["worktrees.retireMissing"]["input"]["observed"],
  removedAt: number,
  assertCurrent?: () => void,
) {
  return await mutateCleanupRecord(
    env,
    {
      type: "worktrees.retireMissing",
      input: { observed, removedAt },
    },
    assertCurrent,
  );
}

async function mutateCleanupRecord<Key extends keyof WorktreeRetirementOperations>(
  env: NodeJS.ProcessEnv,
  command: { type: Key; input: WorktreeRetirementOperations[Key]["input"] },
  assertCurrent?: () => void,
) {
  const context = captureOpenClawStateWorkerContext({ env });
  const { runOpenClawStateWorkerOperation } =
    await import("../../state/openclaw-state-worker-store.js");
  return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((_request, grant) => {
        context.admission.assertCurrent();
        assertCurrent?.();
        grant();
      }),
    }),
  });
}
