import type { CronServiceState } from "../../service/state.js";
import type { CronJob } from "../../types.js";
import { timeoutErrorMessage } from "../errors.js";
import type { CronExecutionResult } from "../types.js";

/** Execute a cron run through the detached isolated-agent path. */
export async function executeDetachedCronTurn(params: {
  state: CronServiceState;
  job: CronJob;
  abortSignal?: AbortSignal;
}): Promise<CronExecutionResult> {
  const { state, job, abortSignal } = params;
  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
  }
  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }

  const res = await state.deps.runIsolatedAgentJob({
    job,
    message: job.payload.message,
    abortSignal,
  });

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }

  return {
    status: res.status,
    error: res.error,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}
