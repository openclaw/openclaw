import type { CronJob, CronSchedule } from "./types.js";

function schedulePayload(
  schedule: CronSchedule,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number } {
  switch (schedule.kind) {
    case "at":
      return { kind: "at", at: schedule.at };
    case "every":
      return { kind: "every", everyMs: schedule.everyMs, anchorMs: schedule.anchorMs };
    case "cron":
      return {
        kind: "cron",
        expr: schedule.expr,
        tz: schedule.tz,
        staggerMs: schedule.staggerMs,
      };
  }
  throw new Error("Unsupported cron schedule kind");
}

export function cronScheduleIdentity(
  job: Pick<CronJob, "schedule"> & { enabled?: boolean },
): string {
  return JSON.stringify({
    version: 1,
    enabled: job.enabled ?? true,
    schedule: schedulePayload(job.schedule),
  });
}

export function cronSchedulingInputsEqual(
  previous: Pick<CronJob, "schedule"> & { enabled?: boolean },
  next: Pick<CronJob, "schedule"> & { enabled?: boolean },
): boolean {
  return cronScheduleIdentity(previous) === cronScheduleIdentity(next);
}
