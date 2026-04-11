import { resolveJobPayloadTextForMain } from "../../service/jobs.js";
import type { CronServiceState } from "../../service/state.js";
import type { CronJob } from "../../types.js";
import { timeoutErrorMessage } from "../errors.js";
import type { CronExecutionResult, WaitWithAbort } from "../types.js";

/** Execute a cron run that targets the main session through the heartbeat-facing path. */
export async function executeMainSessionCronTurn(params: {
  state: CronServiceState;
  job: CronJob;
  abortSignal?: AbortSignal;
  waitWithAbort: WaitWithAbort;
}): Promise<CronExecutionResult> {
  const { state, job, abortSignal, waitWithAbort } = params;
  const text = resolveJobPayloadTextForMain(job);
  if (!text) {
    const kind = job.payload.kind;
    return {
      status: "skipped",
      error:
        kind === "systemEvent"
          ? "main job requires non-empty systemEvent text"
          : 'main job requires payload.kind="systemEvent"',
    };
  }
  const targetMainSessionKey = job.sessionKey;
  state.deps.enqueueSystemEvent(text, {
    agentId: job.agentId,
    sessionKey: targetMainSessionKey,
    contextKey: `cron:${job.id}`,
  });
  if (job.wakeMode === "now" && state.deps.runHeartbeatOnce) {
    const reason = `cron:${job.id}`;
    const isRecurringJob = job.schedule.kind !== "at";
    const maxWaitMs = state.deps.wakeNowHeartbeatBusyMaxWaitMs ?? 2 * 60_000;
    const retryDelayMs = state.deps.wakeNowHeartbeatBusyRetryDelayMs ?? 250;
    const waitStartedAt = state.deps.nowMs();

    for (;;) {
      if (abortSignal?.aborted) {
        return { status: "error", error: timeoutErrorMessage() };
      }
      const heartbeatResult = await state.deps.runHeartbeatOnce({
        reason,
        agentId: job.agentId,
        sessionKey: targetMainSessionKey,
        heartbeat: { target: "last" },
      });
      if (heartbeatResult.status !== "skipped" || heartbeatResult.reason !== "requests-in-flight") {
        if (heartbeatResult.status === "ran") {
          return { status: "ok", summary: text };
        }
        if (heartbeatResult.status === "skipped") {
          return { status: "skipped", error: heartbeatResult.reason, summary: text };
        }
        return { status: "error", error: heartbeatResult.reason, summary: text };
      }
      if (isRecurringJob) {
        state.deps.requestHeartbeatNow({
          reason,
          agentId: job.agentId,
          sessionKey: targetMainSessionKey,
        });
        return { status: "ok", summary: text };
      }
      if (abortSignal?.aborted) {
        return { status: "error", error: timeoutErrorMessage() };
      }
      if (state.deps.nowMs() - waitStartedAt > maxWaitMs) {
        if (abortSignal?.aborted) {
          return { status: "error", error: timeoutErrorMessage() };
        }
        state.deps.requestHeartbeatNow({
          reason,
          agentId: job.agentId,
          sessionKey: targetMainSessionKey,
        });
        return { status: "ok", summary: text };
      }
      await waitWithAbort(retryDelayMs);
    }
  }

  if (abortSignal?.aborted) {
    return { status: "error", error: timeoutErrorMessage() };
  }
  state.deps.requestHeartbeatNow({
    reason: `cron:${job.id}`,
    agentId: job.agentId,
    sessionKey: targetMainSessionKey,
  });
  return { status: "ok", summary: text };
}
