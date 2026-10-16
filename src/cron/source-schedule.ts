import { randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cronStreamScheduleKey } from "./stream-schedule.js";
import type { CronJob, CronSchedule } from "./types.js";

export function isCronEventSchedule(
  value: unknown,
): value is Extract<CronJob["schedule"], { kind: "event" }> {
  return (
    isRecord(value) &&
    value.kind === "event" &&
    typeof value.source === "string" &&
    /^[a-z0-9][a-z0-9._-]*$/.test(value.source) &&
    isRecord(value.options)
  );
}

export function createCronSourceIdentity(): string {
  return randomUUID();
}

export function cronSourceScheduleKey(schedule: CronSchedule): string | undefined {
  if (schedule.kind === "stream") {
    return cronStreamScheduleKey(schedule);
  }
  if (schedule.kind === "event") {
    return stableStringify({
      kind: schedule.kind,
      source: schedule.source,
      options: schedule.options,
    });
  }
  return undefined;
}

/** Stream's shipped field remains canonical for stream jobs; event jobs use the generic field. */
export function cronSourceIdentity(job: Pick<CronJob, "schedule" | "state">): string | undefined {
  return job.schedule.kind === "stream"
    ? job.state.streamSourceIdentity
    : job.schedule.kind === "event"
      ? job.state.sourceIdentity
      : undefined;
}

export function setCronSourceIdentity(
  job: Pick<CronJob, "schedule" | "state">,
  identity: string | undefined,
): void {
  job.state.streamSourceIdentity = job.schedule.kind === "stream" ? identity : undefined;
  job.state.sourceIdentity = job.schedule.kind === "event" ? identity : undefined;
}

/** Shared admission fence for every externally driven source, including stream batches. */
export function ownsCronSource(job: CronJob, scheduleKey: string, identity: string): boolean {
  return (
    cronSourceScheduleKey(job.schedule) === scheduleKey && cronSourceIdentity(job) === identity
  );
}

/** Configuration commits, not adapters, own source generation changes (including A→B→A). */
export function reconcileCronSourceIdentity(previous: CronJob, next: CronJob): void {
  const key = cronSourceScheduleKey(next.schedule);
  if (key === undefined) {
    setCronSourceIdentity(next, undefined);
    return;
  }
  const identity = cronSourceIdentity(previous);
  const changed =
    cronSourceScheduleKey(previous.schedule) !== key ||
    (previous.enabled ?? true) !== (next.enabled ?? true) ||
    Boolean(previous.state.autoDisabled) !== Boolean(next.state.autoDisabled);
  setCronSourceIdentity(next, changed || !identity ? createCronSourceIdentity() : identity);
}
