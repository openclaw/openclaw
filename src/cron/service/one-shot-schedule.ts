/** Authored one-shot occurrence ownership across manual runs and scheduling. */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { parseAbsoluteTimeMs } from "../parse.js";
import { computeNextRunAtMs } from "../schedule.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import type { CronJob, CronRunStatus } from "../types.js";

/** Only explicit conversation continuations can rearm a one-shot through next_check. */
export function isCronOneShotContinuationJob(
  job: Pick<CronJob, "schedule" | "payload" | "sessionTarget">,
): boolean {
  return (
    job.schedule.kind === "at" &&
    job.payload.kind === "agentTurn" &&
    resolveCronSessionTargetSessionKey(job.sessionTarget) !== undefined
  );
}

/** A manual run may retain the authored one-shot even while it has no runnable slot. */
export function resolveForcePreservedOneShotAtMs(job: CronJob): number | undefined {
  const preserved = job.state.forcePreservedNextRunAtMs;
  return job.schedule.kind === "at" &&
    asDateTimestampMs(preserved) !== undefined &&
    preserved === parseAbsoluteTimeMs(job.schedule.at)
    ? preserved
    : undefined;
}

/** Only future occurrences are borrowed; retry or pacing slots take precedence. */
export function resolveManualOneShotOccurrenceAtMs(job: CronJob, ownershipAtMs: number) {
  const occurrenceAtMs =
    job.schedule.kind === "at"
      ? (job.state.nextRunAtMs ?? computeNextRunAtMs(job.schedule, ownershipAtMs))
      : undefined;
  return occurrenceAtMs !== undefined && occurrenceAtMs > ownershipAtMs
    ? occurrenceAtMs
    : undefined;
}

/** Reservation owns this provenance before an enablement edit can make completion stale. */
export function retainManualOneShotOccurrence(job: CronJob, ownershipAtMs: number): void {
  job.state.forcePreservedNextRunAtMs = resolveManualOneShotOccurrenceAtMs(job, ownershipAtMs);
}

/** Retained authored occurrences can recompute a missing runnable slot after enablement. */
export function clearInvalidForcePreservedNextRun(job: CronJob): boolean {
  const preserved = job.state.forcePreservedNextRunAtMs;
  const retainsAuthoredOccurrence =
    job.state.nextRunAtMs === undefined && resolveForcePreservedOneShotAtMs(job) !== undefined;
  if (
    preserved !== undefined &&
    !retainsAuthoredOccurrence &&
    (asDateTimestampMs(preserved) === undefined || preserved !== job.state.nextRunAtMs)
  ) {
    job.state.forcePreservedNextRunAtMs = undefined;
    return true;
  }
  return false;
}

export function computeOneShotNextRunAtMs(job: CronJob, lastRunStatus: CronRunStatus | undefined) {
  const preserved = resolveForcePreservedOneShotAtMs(job);
  if (preserved !== undefined) {
    return preserved;
  }
  const atMs = job.schedule.kind === "at" ? parseAbsoluteTimeMs(job.schedule.at) : null;
  // One-shot jobs stay due until they successfully finish, but if the
  // schedule was updated to a time after the last run, re-arm the job.
  if (lastRunStatus === "ok" && job.state.lastRunAtMs) {
    if (atMs !== null && Number.isFinite(atMs) && atMs > job.state.lastRunAtMs) {
      return atMs;
    }
    return undefined;
  }
  return atMs !== null && Number.isFinite(atMs) ? atMs : undefined;
}
