import type { WorktreeAllocationGuard } from "./allocation.js";
import { requireGit } from "./git.js";
import { updateRegistryWorktree } from "./registry.js";
import { finalizeWorktreeRemoval } from "./run-lease.js";
import type { ManagedWorktreeRecord } from "./types.js";

export async function settleRestoredProjection(
  worktree: ManagedWorktreeRecord,
  env: NodeJS.ProcessEnv,
  assertCurrent: WorktreeAllocationGuard["commitGuard"],
  workerAuthority: WorktreeAllocationGuard["workerAuthority"],
  phase: "restoreSnapshot" | "finishRestore" = "restoreSnapshot",
) {
  const { withSettledLocalWorkspace } =
    await import("../../gateway/worker-environments/local-workspace-projection.js");
  await withSettledLocalWorkspace(
    { worktree, env, assertCurrent, workerAuthority, [phase]: true },
    async () => {},
  );
}

export async function finishRestoredSnapshot(
  params: { id: string } & WorktreeAllocationGuard,
  context: { env: NodeJS.ProcessEnv; recoveryClaim?: string; pendingId?: string },
  record: ManagedWorktreeRecord,
  restoredProvisionedPaths: string[],
  onFinalized: () => void,
  exact = false,
) {
  const { env } = context;
  const gitOptions = {
    signal: params.signal,
    beforeRun: params.commitGuard,
    killProcessTree: true,
  };
  params.commitGuard?.();
  // Advance past the stored stamp even within the same millisecond: stale
  // cleanup writes fence on the activity stamp they observed, so a restore
  // must never revive the row with an identical value.
  const lastActiveAt = Math.max(Date.now(), record.lastActiveAt + 1);
  const restored = { ...record, lastActiveAt };
  delete restored.removedAt;
  delete restored.runEndCleanup;
  const finishRecovery = async () => {
    params.commitGuard?.();
    await requireGit(
      record.repoRoot,
      ["update-ref", "-d", `refs/openclaw/removals/${record.id}`],
      gitOptions,
    );
    await settleRestoredProjection(
      restored,
      env,
      params.commitGuard,
      params.workerAuthority,
      "finishRestore",
    );
  };
  // Settle old leases while the row still refuses new runs. Revival must not race this await.
  if (!context.recoveryClaim) {
    await finalizeWorktreeRemoval(
      env,
      { worktreeId: params.id, lastActiveAt: record.lastActiveAt, removedAt: record.removedAt },
      params.workerAuthority,
    );
  }
  // Exact recovery keeps the row removed until every idempotent cleanup step
  // completes. A live-row retry must never delete leases from a newly admitted run.
  if (exact) {
    await finishRecovery();
  }
  await updateRegistryWorktree(
    env,
    params.id,
    {
      removedAt: undefined,
      lastActiveAt,
      provisionedPaths: restoredProvisionedPaths,
      // The recorded cleanup outcome described the removed lifecycle; a restored
      // checkout starts a new one, so a stale removed-lossless must not show on
      // a live row until the next run-end cleanup records fresh truth.
      runEndCleanup: undefined,
    },
    {
      assertCurrent: params.commitGuard,
      workerAuthority: exact
        ? params.workerAuthority
        : {
            ...params.workerAuthority,
            predicates: [
              ...(params.workerAuthority.predicates ?? []),
              { kind: "exact-snapshot", record },
            ],
          },
      pendingId: context.pendingId,
    },
  );
  onFinalized();
  if (!exact) {
    await finishRecovery();
  }
  return restored;
}
