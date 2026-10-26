import type { UsageDailyBucket } from "../infra/session-cost-usage.types.js";

/** Maps UTC timestamps to the requested report calendar; one instance caches each lookup. */
export function createUsageCalendar(bucket: UsageDailyBucket) {
  const formatter =
    bucket.mode === "time-zone"
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: bucket.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
      : undefined;
  const cache = new Map<
    number,
    { date: string; hour: number; weekday: number; minute: number; second: number; offset: number }
  >();
  function at(timestamp: number) {
    const found = cache.get(timestamp);
    if (found) {
      return found;
    }
    const date = new Date(
      timestamp + (bucket.mode === "utc-offset" ? bucket.utcOffsetMinutes * 60_000 : 0),
    );
    let year = date.getUTCFullYear(),
      month = date.getUTCMonth() + 1,
      day = date.getUTCDate();
    let hour = date.getUTCHours(),
      minute = date.getUTCMinutes(),
      second = date.getUTCSeconds();
    if (formatter) {
      const parts = formatter.formatToParts(timestamp);
      const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value);
      year = value("year");
      month = value("month");
      day = value("day");
      hour = value("hour");
      minute = value("minute");
      second = value("second");
    }
    const calendarMs = Date.UTC(year, month - 1, day, hour, minute, second);
    const result = {
      date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      hour,
      minute,
      second,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      offset: calendarMs - (timestamp - (((timestamp % 1000) + 1000) % 1000)),
    };
    cache.set(timestamp, result);
    return result;
  }
  function quarter(date: string, index: number) {
    if (!Number.isInteger(index) || index < 0 || index > 95 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return null;
    }
    const time = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
      return null;
    }
    return at(time + index * 900_000);
  }
  function nextHour(timestamp: number) {
    const current = at(timestamp);
    const next =
      timestamp +
      (60 - current.minute) * 60_000 -
      current.second * 1000 -
      (((timestamp % 1000) + 1000) % 1000);
    if (at(next - 1).offset === current.offset) {
      return next;
    }
    let low = timestamp + 1,
      high = next - 1;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (at(middle).offset === current.offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
  return { at, quarter, nextHour };
}

export type UsageCalendar = ReturnType<typeof createUsageCalendar>;
