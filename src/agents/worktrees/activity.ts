import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { runOutsideCommandProcessScope } from "../../process/exec-spawn.js";
import { withWorktreeMutationLease } from "./allocation.js";
import {
  assertManagedWorktreeRemovalComplete,
  lockWorktreeForProcess,
  unlockWorktree,
} from "./git-lock.js";
import { readRegistryWorktreeForMutation, requireActiveWorktreeRecord } from "./registry-read.js";
import { assertWorktreeRemovalAvailable, updateRegistryWorktree } from "./registry.js";
import { withWorktreeRunEnd } from "./run-end-lifecycle.js";
import { withGitLockTransition } from "./run-lease.js";
import type { ManagedWorktreeRecord, WorktreeMutationGuard } from "./types.js";

export async function acquireManagedWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  now: () => number,
  params: WorktreeMutationGuard = {},
): Promise<ManagedWorktreeRecord> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    assertWorktreeRemovalAvailable(env, id);
  };
  return withWorktreeRunEnd(env, () =>
    withWorktreeMutationLease(
      {
        ...params,
        env,
        id,
        commitGuard: assertCurrent,
        workerAuthority: params.workerAuthority && {
          ...params.workerAuthority,
          assertCurrent: () => {
            params.workerAuthority?.assertCurrent?.();
            assertCurrent();
          },
        },
      },
      (guard) =>
        // A run cannot adopt this lock until activity publication or its rollback settles.
        withGitLockTransition(id, async () => {
          const record = requireActiveWorktreeRecord(
            id,
            await readRegistryWorktreeForMutation({ ...guard, env, id }),
          );
          await assertManagedWorktreeRemovalComplete(record, {
            signal: guard.signal,
            beforeRun: guard.commitGuard,
          });
          const acquired = await lockWorktreeForProcess(record, {
            signal: guard.signal,
            beforeRun: guard.commitGuard,
          });
          try {
            guard.commitGuard();
            const lastActiveAt = now();
            await updateRegistryWorktree(
              env,
              id,
              { lastActiveAt },
              {
                workerAuthority: {
                  ...guard.workerAuthority,
                  predicates: [
                    ...(guard.workerAuthority.predicates ?? []),
                    { kind: "binding", record },
                  ],
                },
              },
            );
            guard.commitGuard();
            return { ...record, lastActiveAt };
          } catch (error) {
            if (acquired && !hasSqliteWorkerOutcomeUnknown(error)) {
              try {
                await runOutsideCommandProcessScope(() =>
                  unlockWorktree(record, { beforeRun: guard.rollbackGuard }),
                );
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  "Worktree activity publication and Git lock cleanup failed",
                  { cause: cleanupError },
                );
              }
            }
            throw error;
          }
        }),
    ),
  );
}
