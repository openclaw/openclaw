import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createTimeZoneDayKeyFormatter,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.js";
import type { UsageDailyBucket, UsageCivilDays } from "../../infra/session-cost-usage.types.js";
import { createUsageCalendar, type UsageCalendar } from "../../shared/usage-calendar.js";

export type DateRange = {
  startMs: number;
  endMs: number;
  civilDays?: UsageCivilDays;
  includeUntimestamped?: boolean;
};
// Keep validation and parsed timestamps in one result so handlers cannot forward
// an invalid or backwards window to the usage loaders.
type DateRangeResolution = { ok: true; value: DateRange } | { ok: false; error: string };
// 100 years: callers requesting unbounded history should use `range: "all"`.
// Larger explicit day counts would overflow ECMAScript Date arithmetic and
// surface as a misleading "calendar day does not exist" error from the resolver.
const MAX_USAGE_DAYS = 366 * 100;
export type DateInterpretation =
  | { mode: "utc" | "gateway" }
  | { mode: "utc-offset"; utcOffsetMinutes: number }
  | { mode: "time-zone"; timeZone: string; formatDayKey: (date: Date) => string };
type DateInterpretationResolution =
  | { ok: true; value: DateInterpretation }
  | { ok: false; error: string };
type DateParts = { year: number; monthIndex: number; day: number };

const parseDateParts = (raw: unknown): DateParts | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  // The regex only checks shape; Date.* silently rolls impossible calendar dates over
  // (e.g. 2026-02-30 -> 2026-03-02), so a typo'd day would return usage for the wrong day.
  // Reject parts that don't round-trip through a UTC probe (also catches the JS 2-digit-year remap).
  const probe = new Date(Date.UTC(year, monthIndex, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthIndex ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, monthIndex, day };
};

const shiftDateParts = (parts: DateParts, days: number): DateParts => {
  const shifted = new Date(Date.UTC(parts.year, parts.monthIndex, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
};

const DAY_MS = 86_400_000;

/** Intersect the civil day with each constant-offset period around it. */
function zonedDayBounds(midnight: number, calendar: UsageCalendar) {
  const low = midnight - DAY_MS;
  const high = midnight + 2 * DAY_MS;
  const before = calendar.at(low).offset;
  const after = calendar.at(high).offset;
  const firstStart = midnight - before;
  const lastEnd = midnight + DAY_MS - after - 1;
  if (before === after) {
    return { startMs: firstStart, endMs: lastEnd };
  }
  // IANA offset transitions are separated by more than this three-day window.
  // Unlike local day labels, membership in the old offset period is monotonic.
  let left = low;
  let right = high;
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (calendar.at(middle).offset === before) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  const firstEnd = Math.min(left - 1, firstStart + DAY_MS - 1);
  const lastStart = Math.max(left, midnight - after);
  if (firstStart > firstEnd) {
    return lastStart <= lastEnd ? { startMs: lastStart, endMs: lastEnd } : undefined;
  }
  if (lastStart > lastEnd) {
    return { startMs: firstStart, endMs: firstEnd };
  }
  return { startMs: firstStart, endMs: lastEnd, disjoint: firstEnd + 1 < lastStart };
}

/**
 * Parse a UTC offset string in the format UTC+H, UTC-H, UTC+HH, UTC-HH, UTC+H:MM, UTC-HH:MM.
 * Returns the UTC offset in minutes (east-positive), or undefined if invalid.
 */
const parseUtcOffsetToMinutes = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  const totalMinutes = sign * (hours * 60 + minutes);
  if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) {
    return undefined;
  }
  return totalMinutes;
};

export const resolveDateInterpretation = (params: {
  mode?: unknown;
  utcOffset?: unknown;
  timeZone?: unknown;
}): DateInterpretationResolution => {
  if (params.mode === "gateway") {
    return { ok: true, value: { mode: "gateway" } };
  }
  if (params.mode === "specific") {
    const utcOffsetMinutes = parseUtcOffsetToMinutes(params.utcOffset);
    if (params.timeZone !== undefined && params.timeZone !== null) {
      const requestedTimeZone = normalizeOptionalString(params.timeZone);
      const timeZone = requestedTimeZone ? resolveTimezone(requestedTimeZone) : undefined;
      if (!timeZone) {
        // Browser tzdata can lead Gateway ICU. Preserve legacy fixed-offset
        // reporting when the concurrently supplied offset is still usable.
        if (utcOffsetMinutes !== undefined) {
          return { ok: true, value: { mode: "utc-offset", utcOffsetMinutes } };
        }
        return { ok: false, error: "invalid timeZone: expected a valid IANA time zone" };
      }
      return {
        ok: true,
        value: {
          mode: "time-zone",
          timeZone,
          formatDayKey: createTimeZoneDayKeyFormatter(timeZone),
        },
      };
    }
    if (utcOffsetMinutes !== undefined) {
      return { ok: true, value: { mode: "utc-offset", utcOffsetMinutes } };
    }
    // Only omission or blank text requests UTC; malformed offsets must not select another day.
    if (
      params.utcOffset != null &&
      (typeof params.utcOffset !== "string" || params.utcOffset.trim() !== "")
    ) {
      return { ok: false, error: "invalid utcOffset: expected UTC-12:00 through UTC+14:00" };
    }
  }
  // Backward compatibility: when mode is missing (or invalid), keep current UTC interpretation.
  return { ok: true, value: { mode: "utc" } };
};

export const resolveDayBucket = (
  interpretation: DateInterpretation,
  civilDays?: UsageCivilDays,
): UsageDailyBucket | undefined => {
  if (interpretation.mode === "gateway") {
    return civilDays
      ? { mode: "time-zone", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, civilDays }
      : undefined;
  }
  if (interpretation.mode === "time-zone") {
    return {
      mode: "time-zone",
      timeZone: interpretation.timeZone,
      ...(civilDays && { civilDays }),
    };
  }
  return {
    mode: "utc-offset",
    utcOffsetMinutes: interpretation.mode === "utc-offset" ? interpretation.utcOffsetMinutes : 0,
  };
};

const getDateParts = (date: Date, interpretation: DateInterpretation): DateParts => {
  if (interpretation.mode === "gateway") {
    return { year: date.getFullYear(), monthIndex: date.getMonth(), day: date.getDate() };
  }
  if (interpretation.mode === "time-zone") {
    const parts = parseDateParts(interpretation.formatDayKey(date));
    if (!parts) {
      throw new Error("timezone formatter returned an invalid calendar day");
    }
    return parts;
  }
  const utcDate =
    interpretation.mode === "utc-offset"
      ? new Date(date.getTime() + interpretation.utcOffsetMinutes * 60 * 1000)
      : date;
  return {
    year: utcDate.getUTCFullYear(),
    monthIndex: utcDate.getUTCMonth(),
    day: utcDate.getUTCDate(),
  };
};

export const formatDateLabel = (ms: number, interpretation: DateInterpretation): string => {
  const parts = getDateParts(new Date(ms), interpretation);
  return formatDateParts(parts.year, parts.monthIndex, parts.day);
};

const formatDateParts = (year: number, monthIndex: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const parseDays = (raw: unknown): number | undefined => {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.floor(value), MAX_USAGE_DAYS)
    : undefined;
};

const RANGE_DAYS = new Map<unknown, number | "all">([
  ["all", "all"],
  ["7d", 7],
  ["30d", 30],
  ["90d", 90],
  ["1y", 365],
]);

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
export const resolveDateRange = (
  params: {
    startDate?: unknown;
    endDate?: unknown;
    days?: unknown;
    range?: unknown;
    mode?: unknown;
    utcOffset?: unknown;
    timeZone?: unknown;
  },
  resolvedInterpretation?: DateInterpretation,
): DateRangeResolution => {
  const dates = {
    startDate: parseDateParts(params.startDate),
    endDate: parseDateParts(params.endDate),
  };
  for (const field of ["startDate", "endDate"] as const) {
    const raw = params[field];
    if (
      raw != null &&
      (typeof raw !== "string" || raw.trim() !== "") &&
      dates[field] === undefined
    ) {
      return {
        ok: false,
        error: `invalid ${field}: expected a valid YYYY-MM-DD calendar date`,
      };
    }
  }

  const now = new Date();
  const interpretationResolution = resolvedInterpretation
    ? { ok: true as const, value: resolvedInterpretation }
    : resolveDateInterpretation(params);
  if (!interpretationResolution.ok) {
    return interpretationResolution;
  }
  const interpretation = interpretationResolution.value;
  const { startDate: explicitStart, endDate: explicitEnd } = dates;
  if ((explicitStart === undefined) !== (explicitEnd === undefined)) {
    return { ok: false, error: "startDate and endDate must be provided together" };
  }
  const rangeDays = RANGE_DAYS.get(params.range);
  const all = !explicitStart && rangeDays === "all";
  const end = explicitEnd ?? getDateParts(now, interpretation);
  const days =
    typeof rangeDays === "number" ? rangeDays : Math.max(1, parseDays(params.days) ?? 30);
  const start = explicitStart ?? (all ? end : shiftDateParts(end, 1 - days));
  const calendarBucket = resolveDayBucket(interpretation);
  const calendar =
    calendarBucket?.mode === "utc-offset"
      ? undefined
      : createUsageCalendar(
          calendarBucket ?? {
            mode: "time-zone",
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        );
  const bounds = (
    parts: DateParts,
  ): { startMs: number; endMs: number; disjoint?: boolean } | undefined => {
    const midnight = Date.UTC(parts.year, parts.monthIndex, parts.day);
    if (calendar) {
      return zonedDayBounds(midnight, calendar);
    }
    const startMs =
      midnight -
      (interpretation.mode === "utc-offset" ? interpretation.utcOffsetMinutes * 60_000 : 0);
    return { startMs, endMs: startMs + DAY_MS - 1 };
  };
  const startDay = bounds(start);
  const endDay =
    start.year === end.year && start.monthIndex === end.monthIndex && start.day === end.day
      ? startDay
      : bounds(end);
  if (!startDay || !endDay) {
    return { ok: false, error: "calendar day does not exist in requested time zone" };
  }
  if (startDay.startMs > endDay.startMs) {
    return { ok: false, error: "startDate must not be after endDate" };
  }
  return {
    ok: true,
    value: {
      startMs: all ? 0 : startDay.startMs,
      endMs: endDay.endMs,
      ...(all ? { includeUntimestamped: true } : {}),
      ...(startDay.disjoint || endDay.disjoint
        ? {
            civilDays: {
              from: all ? "" : formatDateParts(start.year, start.monthIndex, start.day),
              through: formatDateParts(end.year, end.monthIndex, end.day),
            },
          }
        : {}),
    },
  };
};
