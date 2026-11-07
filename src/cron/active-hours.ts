import { resolveUserTimezone } from "../agents/date-time.js";
import type { CronActiveHours } from "./types-shared.js";

export function assertCronActiveHours(active: CronActiveHours): void {
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(active.start) ||
    !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(active.end)
  ) {
    throw new Error("cron activeHours requires HH:MM start/end (24:00 is allowed only for end)");
  }
  if (active.timezone !== undefined && active.timezone !== "user" && active.timezone !== "local") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: active.timezone }).format(0);
    } catch {
      throw new Error("cron activeHours.timezone must be user, local, or an IANA timezone");
    }
  }
}

/** Wall-clock comparison preserves overnight windows and both DST occurrences. */
export function isCronWithinActiveHours(
  active: CronActiveHours | undefined,
  nowMs: number,
  userTimezone?: string,
): boolean {
  if (!active) {
    return true;
  }
  const timezone = active.timezone;
  const timeZone =
    !timezone || timezone === "user"
      ? resolveUserTimezone(userTimezone)
      : timezone === "local"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : timezone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const minute =
    Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(active.start);
  const end = minutes(active.end);
  return start === end
    ? false
    : end > start
      ? minute >= start && minute < end
      : minute >= start || minute < end;
}
