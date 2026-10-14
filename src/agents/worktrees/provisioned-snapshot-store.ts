import { randomUUID } from "node:crypto";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { GitWorktreeEffect } from "./git-worktree-operations.js";
import { runWorktreeRunEndCommand } from "./registry-run-end.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { WorktreeWorkerAuthority } from "./types.js";

type ProvisionedSnapshotEffect = Extract<
  GitWorktreeEffect,
  { type: "worktree.snapshot-provisioned-reset" | "worktree.snapshot-provisioned-chunk" }
>;

/** One captured database generation owns every chunk and cleanup in a snapshot. */
export function createProvisionedSnapshotWriter(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  authority: WorktreeWorkerAuthority = {},
) {
  const context = captureWorktreeRunEndContext(env);
  const predicates = structuredClone(authority.predicates);
  const leaseSet = authority.leaseSet;
  const assertCurrent = authority.assertCurrent;
  let uncertain: { error: unknown } | undefined;
  return async (
    effect: ProvisionedSnapshotEffect,
    signal: AbortSignal | undefined = authority.signal,
  ): Promise<void> => {
    if (uncertain) {
      throw uncertain.error;
    }
    try {
      await runWorktreeRunEndCommand(
        context,
        {
          type: "worktrees.writeProvisionedSnapshot",
          input: {
            value:
              effect.type === "worktree.snapshot-provisioned-reset"
                ? { worktreeId, kind: "reset" }
                : { worktreeId, kind: "chunk", ...effect.input },
            receipt: randomUUID(),
          },
        },
        {
          leaseSet,
          predicates,
          signal,
          assertCurrent: () => {
            assertCurrent?.();
            signal?.throwIfAborted();
          },
        },
      );
    } catch (error) {
      // Git transports an error's code, while this host retains its native settlement identity.
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        uncertain = { error };
      }
      throw error;
    }
  };
}

export async function clearRegistryWorktreeProvisionedChunks(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  authority?: WorktreeWorkerAuthority,
): Promise<void> {
  await createProvisionedSnapshotWriter(
    env,
    worktreeId,
    authority,
  )({
    type: "worktree.snapshot-provisioned-reset",
    input: {},
  });
}
