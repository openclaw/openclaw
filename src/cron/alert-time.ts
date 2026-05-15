import type { CronJob } from "./types.js";

function resolveCronAlertTimeZone(job: Pick<CronJob, "schedule">): string {
  if (job.schedule.kind === "cron" && typeof job.schedule.tz === "string" && job.schedule.tz) {
    return job.schedule.tz;
  }
  return "UTC";
}

function formatInTimeZone(date: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    if (!year || !month || !day || !hour || !minute) {
      return null;
    }
    return `${year}-${month}-${day} ${hour === "24" ? "00" : hour}:${minute} (${timeZone})`;
  } catch {
    return null;
  }
}

export function formatCronAlertEventTime(params: {
  job: Pick<CronJob, "schedule">;
  eventTimeMs?: number;
}): string | undefined {
  if (typeof params.eventTimeMs !== "number" || !Number.isFinite(params.eventTimeMs)) {
    return undefined;
  }
  const date = new Date(params.eventTimeMs);
  const timeZone = resolveCronAlertTimeZone(params.job);
  return formatInTimeZone(date, timeZone) ?? formatInTimeZone(date, "UTC") ?? undefined;
}
