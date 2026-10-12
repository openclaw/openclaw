import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveCronTriggerMinIntervalMs } from "../../config/cron-limits.js";
import type { CronJob } from "../types.js";

export function hasPendingCronTriggerInterval(job: CronJob, nowMs: number): boolean {
  const nextRunAtMs = asDateTimestampMs(job.state.nextRunAtMs);
  // Busy evaluations update the job timestamp without changing trigger history.
  const lastActivityAtMs = Math.max(job.updatedAtMs, job.state.lastTriggerEvalAtMs ?? 0);
  return (
    job.trigger !== undefined &&
    nextRunAtMs !== undefined &&
    nextRunAtMs > 0 &&
    nowMs < nextRunAtMs &&
    nextRunAtMs <= lastActivityAtMs + resolveCronTriggerMinIntervalMs()
  );
}
