import { GitCommandTimeoutError } from "../../infra/git-exec.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { WorktreeWorkerOperations } from "./dispatch.worker.js";
import type { WorktreePreservationReason } from "./errors.js";
import { readRegistryWorktreeForMutation } from "./registry-read.js";
import { runWorktreeRegistryCommand } from "./registry-run-end.js";
import { createWorktreeRemovalClaimsGuard } from "./registry.js";
import { worktreePreservationReason } from "./removal-errors.js";
import {
  captureWorktreeRunEndContext,
  captureWorktreeRegistryMutation,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "./run-end-lifecycle.js";
import type { ManagedWorktreeRecord, WorktreeRemovalDeferral } from "./types.js";

export function worktreeCleanupProtection(
  record: ManagedWorktreeRecord,
  now: number,
  retryDeferred = false,
): string | undefined {
  const retry = record.gcRetry;
  return retry && !retryDeferred && (retry.retryAt === null || now < retry.retryAt)
    ? record.gcProtection
    : undefined;
}

export function removalDeferralReason(
  error: unknown,
): { reason: string; stage?: WorktreePreservationReason } | undefined {
  const stage = worktreePreservationReason(error);
  if (stage) {
    return {
      stage,
      reason: `Checkout preserved: ${stage}; repair the checkout, then run openclaw worktrees gc --retry-deferred`,
    };
  }
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof GitCommandTimeoutError) {
      return { reason: "Git removal timed out; cleanup deferred" };
    }
  }
  return undefined;
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
  observed?: ManagedWorktreeRecord;
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
  const observed =
    params.observed ??
    (await readRegistryWorktreeForMutation({
      env: params.env,
      id: params.id,
      commitGuard: assertCurrent,
    }));
  if (!observed || observed.removedAt !== undefined) {
    return undefined;
  }
  const attempts = Math.min(params.previousAttempts + 1, Number.MAX_SAFE_INTEGER);
  const terminal =
    params.stage === "nested-repository" ||
    (attempts >= 3 &&
      (params.stage === "repository-corrupt" || params.stage === "permission-denied"));
  const retry: WorktreeRemovalDeferral = {
    stage: params.stage,
    elapsedMs: params.elapsedMs,
    attempts,
    retryAt: terminal ? null : params.now + Math.min(24, 2 ** Math.min(attempts, 5)) * 60 * 60_000,
  };
  const recorded = await deferWorktreeCleanup(
    params.env,
    {
      observed,
      reason: terminal
        ? `${params.reason}; automatic retries stopped after ${attempts} attempt(s)`
        : params.reason,
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
  const mutation = captureWorktreeRegistryMutation(context, [
    {
      id: command.input.observed.id,
      fields: [command.type === "worktrees.retireMissing" ? "removal" : "cleanup"],
    },
  ]);
  return await withWorktreeRunEnd(env, async () => {
    try {
      return await runWorktreeRegistryCommand(context, (scope) => scope.execute(command), {
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
