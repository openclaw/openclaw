import { bucketRelativeTimeMs } from "@openclaw/normalization-core";
import type { CronJob } from "../api/types.ts";
import { registerCronScheduleEnglish } from "../i18n/locales/en-cron-schedule.ts";
import { isCronJobRunning } from "./cron-status.ts";
import { formatDateMs, formatTimeMs, formatUnit } from "./format.ts";
import { registerEnglishCatalog, t } from "./reactive/i18n.ts";
import { readVisibleTime } from "./reactive/visible-clock.ts";

registerEnglishCatalog(registerCronScheduleEnglish);

/** Scheduler runtime facts; the authored occurrence never decides what happens next. */
export type AutomationNextRunFacts = {
  enabled: boolean;
  running: boolean;
  autoDisabled: boolean;
  waiting: boolean;
  /** Scheduler-owned deadline; null when nothing is queued. */
  nextRunAtMs: number | null;
};

export function cronJobNextRunFacts(job: CronJob): AutomationNextRunFacts {
  return {
    enabled: job.enabled,
    running: isCronJobRunning(job),
    autoDisabled: Boolean(job.state?.autoDisabled),
    waiting: Boolean(job.state?.admissionDeferred),
    nextRunAtMs: job.state?.nextRunAtMs ?? null,
  };
}

/** Wall-clock schedules repeat; a one-shot stays one-shot even after an explicit rearm. */
export function isRecurringSchedule(schedule: CronJob["schedule"]): boolean {
  return schedule.kind === "every" || schedule.kind === "cron";
}

const localDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

function calendarTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const days = localDay(at) - localDay(now);
  const time = formatTimeMs(atMs);
  if (days === 0) {
    return t("cron.scheduleLabel.todayAt", { time });
  }
  if (days === 1) {
    return t("cron.scheduleLabel.tomorrowAt", { time });
  }
  const day = formatDateMs(atMs, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return t("cron.scheduleLabel.dateAt", { day, time });
}

/** Countdown first, then the same deadline as local calendar time. */
function formatAutomationNextRun(facts: AutomationNextRunFacts, nowMs: number): string {
  if (facts.running) {
    return t("cron.scheduleLabel.running");
  }
  if (facts.autoDisabled) {
    return t("cron.scheduleLabel.noRun");
  }
  if (!facts.enabled) {
    return t("cron.scheduleLabel.paused");
  }
  if (facts.waiting) {
    return t("cron.scheduleLabel.waiting");
  }
  if (facts.nextRunAtMs === null) {
    return t("cron.scheduleLabel.noRun");
  }
  const remainingMs = facts.nextRunAtMs - nowMs;
  // A passed deadline that has not started is due, never a negative or invented countdown.
  if (remainingMs <= 0) {
    return t("cron.scheduleLabel.due");
  }
  const { value, unit } = bucketRelativeTimeMs(remainingMs);
  const countdown = formatUnit({
    value: Math.max(1, value),
    unit,
    // "2 min" scans faster than "2 minutes"; "18 hr" reads worse than "18 hours".
    unitDisplay: unit === "second" || unit === "minute" ? "short" : "long",
  });
  return t("cron.scheduleLabel.nextIn", {
    countdown,
    when: calendarTime(facts.nextRunAtMs, nowMs),
  });
}

/** Tracked reader: ticks every second near the deadline and every 30 seconds otherwise. */
export function readAutomationNextRun(facts: AutomationNextRunFacts): string {
  const near = facts.nextRunAtMs !== null && facts.nextRunAtMs - Date.now() < 120_000;
  return formatAutomationNextRun(facts, readVisibleTime(near ? 1_000 : 30_000));
}
