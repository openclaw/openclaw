import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { GitWorktreeEffect } from "./git-worktree-operations.js";

type ProvisionedSnapshotEffect = Extract<
  GitWorktreeEffect,
  { type: "worktree.snapshot-provisioned-reset" | "worktree.snapshot-provisioned-chunk" }
>;

/** One captured database generation owns every chunk and cleanup in a snapshot. */
export function createProvisionedSnapshotWriter(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  assertCurrent: () => void,
) {
  const context = captureOpenClawStateWorkerContext({ env });
  return async (
    effect: ProvisionedSnapshotEffect,
    assertEffectCurrent?: () => void,
  ): Promise<void> => {
    const assertWriteCurrent = () => {
      assertCurrent();
      assertEffectCurrent?.();
    };
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
    try {
      await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "worktrees.writeProvisionedSnapshot",
            input:
              effect.type === "worktree.snapshot-provisioned-reset"
                ? { worktreeId, kind: "reset" }
                : { worktreeId, kind: "chunk", ...effect.input },
          }),
        {
          assertCurrent: assertWriteCurrent,
          createAdmission: (operation) => {
            settled = operation.settled;
            return {
              nativeLocations: [context.admission.databasePath],
              admission: createSqliteWorkerOperationAdmission((_request, grant) => {
                context.admission.assertCurrent();
                assertWriteCurrent();
                grant();
              }),
            };
          },
        },
      );
    } finally {
      await settled;
    }
  };
}

export async function clearRegistryWorktreeProvisionedChunks(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  assertCurrent: () => void,
): Promise<void> {
  await createProvisionedSnapshotWriter(
    env,
    worktreeId,
    assertCurrent,
  )({
    type: "worktree.snapshot-provisioned-reset",
    input: {},
  });
}
