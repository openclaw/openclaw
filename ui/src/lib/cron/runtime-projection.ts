import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { CronCompactJob, CronJob } from "../../api/types.ts";
import type { Runtime } from "./inventory-connection.ts";

export function applyFullCronRuntime(previous: CronJob, event: Omit<Runtime, "revision">): CronJob {
  return {
    ...previous,
    updatedAtMs: event.job.updatedAtMs,
    state: {
      ...previous.state,
      nextRunAtMs: event.job.state.nextRunAtMs,
      lastRunAtMs: event.job.state.lastRunAtMs,
      lastRunStatus: event.job.state.lastRunStatus,
      lastStatus: event.job.state.lastStatus,
      runningAtMs: event.job.state.runningAtMs,
      autoDisabled: event.job.state.autoDisabled,
      admissionDeferred: event.job.state.admissionDeferred,
      lastDurationMs: event.job.state.lastDurationMs,
      lastMeaningfulResult: event.job.state.lastMeaningfulResult,
      lastTriggerEvalAtMs: event.job.state.lastTriggerEvalAtMs,
      ...(event.action === "finished"
        ? { lastError: event.error, lastDurationMs: event.durationMs }
        : {}),
    },
  };
}

export function applyCompactCronRuntime(
  previous: CronCompactJob,
  event: Omit<Runtime, "revision">,
): CronCompactJob {
  const runtime = event.job.state;
  return {
    ...previous,
    updatedAtMs: event.job.updatedAtMs,
    nextRunAt: timestampMsToIsoString(runtime.nextRunAtMs) ?? null,
    nextRunAtMs: runtime.nextRunAtMs ?? null,
    lastRunAt: timestampMsToIsoString(runtime.lastRunAtMs) ?? null,
    lastRunAtMs: runtime.lastRunAtMs ?? null,
    lastRunStatus: runtime.lastRunStatus ?? runtime.lastStatus ?? null,
    runningAtMs: runtime.runningAtMs,
    autoDisabled: runtime.autoDisabled,
    admissionDeferred: runtime.admissionDeferred,
    lastDurationMs: runtime.lastDurationMs,
    lastMeaningfulResult: runtime.lastMeaningfulResult,
    lastTriggerEvalAtMs: runtime.lastTriggerEvalAtMs,
    ...(event.action === "finished"
      ? { lastRunError: event.error ?? null, lastDurationMs: event.durationMs }
      : {}),
  };
}
