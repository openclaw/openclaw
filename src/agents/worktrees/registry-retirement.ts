import { GitCommandTimeoutError } from "../../infra/git-exec.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { WorktreeWorkerOperations } from "./dispatch.worker.js";
import { readRegistryWorktreeForMutation } from "./registry-read.js";
import { runWorktreeRegistryCommand } from "./registry-run-end.js";
import { createWorktreeRemovalClaimsGuard } from "./registry.js";
import {
  captureWorktreeRunEndContext,
  captureWorktreeRegistryMutation,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "./run-end-lifecycle.js";
import type { WorktreeRemovalDeferral } from "./types.js";

export function isWorktreeRemovalTimeout(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof GitCommandTimeoutError) {
      return true;
    }
  }
  return false;
}

/** Keep a failed attempt with the registry revision that still owns its checkout. */
export async function deferFailedWorktreeRemoval(params: {
  env: NodeJS.ProcessEnv;
  id: string;
  stage: string;
  reason: string;
  elapsedMs: number;
  now: number;
  previousAttempts: number;
  claimToken?: string;
  assertCurrent: () => void;
}): Promise<WorktreeRemovalDeferral | undefined> {
  const assertClaim = params.claimToken
    ? createWorktreeRemovalClaimsGuard(params.env, [params.id], params.claimToken)
    : undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    assertClaim?.();
  };
  // An admitted deletion can outlive cancellation and update its snapshot before
  // failing. Capture the revision under retained custody before releasing the claim.
  const observed = await readRegistryWorktreeForMutation({
    env: params.env,
    id: params.id,
    commitGuard: assertCurrent,
  });
  if (!observed || observed.removedAt !== undefined) {
    return undefined;
  }
  const attempts = Math.min(params.previousAttempts + 1, Number.MAX_SAFE_INTEGER);
  const retry: WorktreeRemovalDeferral = {
    stage: params.stage,
    elapsedMs: params.elapsedMs,
    attempts,
    retryAt: params.now + Math.min(24, 2 ** Math.min(attempts, 5)) * 60 * 60_000,
  };
  const recorded = await deferWorktreeCleanup(
    params.env,
    {
      observed,
      reason: params.reason,
      retry,
      removalToken: params.claimToken,
    },
    assertCurrent,
  );
  return recorded ? retry : undefined;
}

type WorktreeRetirementOperations = Pick<
  WorktreeWorkerOperations,
  "worktrees.deferCleanup" | "worktrees.retireMissing"
>;

export async function deferWorktreeCleanup(
  env: NodeJS.ProcessEnv,
  input: WorktreeRetirementOperations["worktrees.deferCleanup"]["input"],
  assertCurrent?: () => void,
) {
  return await mutateCleanupRecord(env, { type: "worktrees.deferCleanup", input }, assertCurrent);
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
  const context = captureWorktreeRunEndContext(env);
  const captured = structuredClone(command);
  const mutation = captureWorktreeRegistryMutation(context, [
    {
      id: captured.input.observed.id,
      fields: [captured.type === "worktrees.retireMissing" ? "removal" : "cleanup"],
    },
  ]);
  return await withWorktreeRunEnd(env, async () => {
    try {
      return await runWorktreeRegistryCommand(context, (scope) => scope.execute(captured), {
        assertCurrent: () => mutation.assertAuthority(() => assertCurrent?.()),
        mutation,
        unknownMessage: "Worktree retirement outcome is unknown",
        recover: (committed) => {
          if (committed.result.kind === "unknown") {
            throw new SqliteWorkerError(
              "Worktree retirement committed but its result is unavailable; reread the registry",
              "unavailable",
            );
          }
          // SAFETY: The retained admission owns this typed command and its worker's captured result.
          return { value: committed.result.value as WorktreeRetirementOperations[Key]["output"] };
        },
      });
    } catch (error) {
      retainWorktreeRunEndFailure(error);
      throw error;
    }
  });
}
