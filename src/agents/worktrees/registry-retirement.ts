import { GitCommandTimeoutError } from "../../infra/git-exec.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import type { WorktreeWorkerOperations } from "./dispatch.worker.js";
import {
  captureWorktreeRunEndContext,
  captureWorktreeRegistryMutation,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "./run-end-lifecycle.js";
import type { ManagedWorktreeRecord, WorktreeRemovalDeferral } from "./types.js";

export function isWorktreeRemovalTimeout(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof GitCommandTimeoutError) {
      return true;
    }
  }
  return false;
}

/** Keep a timed-out attempt with the registry revision that still owns its checkout. */
export async function deferTimedOutWorktreeRemoval(params: {
  env: NodeJS.ProcessEnv;
  observed: ManagedWorktreeRecord;
  stage: string;
  elapsedMs: number;
  now: number;
  previousAttempts: number;
  claimToken: string;
  assertCurrent: () => void;
}): Promise<WorktreeRemovalDeferral | undefined> {
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
      observed: params.observed,
      reason: `Git ${params.stage} timed out; cleanup deferred`,
      retry,
      removalToken: params.claimToken,
    },
    params.assertCurrent,
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
    let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
    const execute = async () => {
      const { runOpenClawStateWorkerOperation } =
        await import("../../state/openclaw-state-worker-store.js");
      return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(captured), {
        createAdmission: (operation) => {
          settled = operation.settled;
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              if (request.stage === "transaction") {
                mutation.observeTransaction();
              }
              context.admission.assertCurrent();
              mutation.assertAuthority(() => assertCurrent?.());
              grant();
            }),
          };
        },
      });
    };
    const result = await execute().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const outcome = await settled;
    mutation.settle(outcome?.kind === "unknown");
    if (outcome?.kind === "unknown") {
      const error = new SqliteWorkerError(
        "Worktree retirement outcome is unknown",
        "outcome-unknown",
      );
      retainWorktreeRunEndFailure(error);
      throw error;
    }
    if (!result.ok) {
      retainWorktreeRunEndFailure(result.error);
      throw result.error;
    }
    return result.value;
  });
}
