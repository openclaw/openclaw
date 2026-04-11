import type { CronServiceState } from "../service/state.js";
import { resolveCronJobTimeoutMs } from "../service/timeout-policy.js";
import type { CronJob } from "../types.js";
import { executeDetachedCronTurn } from "./adapters/detached-session-turn.js";
import { executeMainSessionCronTurn } from "./adapters/main-session-turn.js";
import { timeoutErrorMessage } from "./errors.js";
import type { CronExecutionResult, WaitWithAbort } from "./types.js";

function createWaitWithAbort(abortSignal?: AbortSignal): WaitWithAbort {
  return async (ms: number) => {
    if (!abortSignal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  };
}

/** Dispatch a cron run through the appropriate execution adapter for its session target. */
export async function executeCronRunCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
): Promise<CronExecutionResult> {
  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }
  if (job.sessionTarget === "main") {
    return await executeMainSessionCronTurn({
      state,
      job,
      abortSignal,
      waitWithAbort: createWaitWithAbort(abortSignal),
    });
  }

  return await executeDetachedCronTurn({
    state,
    job,
    abortSignal,
  });
}

/** Wrap cron execution with the per-job timeout policy before dispatching to adapters. */
export async function executeCronRunCoreWithTimeout(
  state: CronServiceState,
  job: CronJob,
): Promise<CronExecutionResult> {
  const jobTimeoutMs = resolveCronJobTimeoutMs(job);
  if (typeof jobTimeoutMs !== "number") {
    return await executeCronRunCore(state, job);
  }

  const runAbortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      executeCronRunCore(state, job, runAbortController.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          runAbortController.abort(timeoutErrorMessage());
          reject(new Error(timeoutErrorMessage()));
        }, jobTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
