import { withWorktreeMutationLease } from "./allocation.js";
import { worktreePathExists } from "./git.js";
import { readRegistryWorktree } from "./registry-read.js";
import { retireMissingRegistryWorktree } from "./registry-retirement.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { ManagedWorktreeRecord } from "./types.js";

export async function reconcileListedWorktrees(
  env: NodeJS.ProcessEnv,
  records: readonly ManagedWorktreeRecord[],
  now: () => number,
): Promise<ManagedWorktreeRecord[]> {
  const context = captureWorktreeRunEndContext(env);
  const listed: ManagedWorktreeRecord[] = [];
  for (const observed of records) {
    const record =
      observed.removedAt === undefined && !(await worktreePathExists(observed.path))
        ? await withWorktreeMutationLease({ env, id: observed.id }, async (guard) => {
            context.admission.assertCurrent();
            const current = await readRegistryWorktree(context, observed.id);
            guard.commitGuard();
            if (
              !current ||
              current.removedAt !== undefined ||
              (await worktreePathExists(current.path))
            ) {
              return current;
            }
            return (
              await retireMissingRegistryWorktree(context.environment, current, now(), () => {
                context.admission.assertCurrent();
                guard.commitGuard();
              })
            ).record;
          })
        : observed;
    if (record && (record.removedAt === undefined || record.snapshotRef)) {
      listed.push(record);
    }
  }
  return listed;
}
