import { resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/config.js";

type HumanDateTimeParts = {
  timeZone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayKey: string;
};

function resolvePart(parts: Intl.DateTimeFormatPart[], type: string): string | undefined {
  return parts.find((part) => part.type === type)?.value;
}

function formatDayKeyFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shiftDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDayKeyFromParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

function resolveShortOffsetMinutes(nowMs: number, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const raw = resolvePart(parts, "timeZoneName")?.trim();
    if (!raw || raw === "GMT" || raw === "UTC") {
      return 0;
    }
    const match = raw.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) {
      return undefined;
    }
    const sign = match[1] === "-" ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] ?? "0");
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
      return undefined;
    }
    return sign * (hours * 60 + minutes);
  } catch {
    return undefined;
  }
}

function resolveHumanDateTimeParts(nowMs: number, cfg?: OpenClawConfig): HumanDateTimeParts {
  const timeZone = resolveHumanTimezone(cfg);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const year = Number(resolvePart(parts, "year"));
    const month = Number(resolvePart(parts, "month"));
    const day = Number(resolvePart(parts, "day"));
    const hour = Number(resolvePart(parts, "hour"));
    const minute = Number(resolvePart(parts, "minute"));
    const second = Number(resolvePart(parts, "second"));
    if (
      [year, month, day, hour, minute, second].every((value) => Number.isFinite(value)) &&
      year > 0 &&
      month > 0 &&
      day > 0
    ) {
      return {
        timeZone,
        year,
        month,
        day,
        hour,
        minute,
        second,
        dayKey: formatDayKeyFromParts(year, month, day),
      };
    }
  } catch {
    // Fall through to UTC-derived values below.
  }

  const fallback = new Date(nowMs);
  return {
    timeZone,
    year: fallback.getUTCFullYear(),
    month: fallback.getUTCMonth() + 1,
    day: fallback.getUTCDate(),
    hour: fallback.getUTCHours(),
    minute: fallback.getUTCMinutes(),
    second: fallback.getUTCSeconds(),
    dayKey: fallback.toISOString().slice(0, 10),
  };
}

export function resolveHumanTimezone(cfg?: OpenClawConfig): string {
  return resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
}

export function formatHumanDayKey(value: number | Date, cfg?: OpenClawConfig): string {
  const nowMs = value instanceof Date ? value.getTime() : value;
  return resolveHumanDateTimeParts(nowMs, cfg).dayKey;
}

export function formatHumanTime(
  value: number | Date,
  cfg?: OpenClawConfig,
  opts?: { compact?: boolean; includeSeconds?: boolean },
): string {
  const nowMs = value instanceof Date ? value.getTime() : value;
  const parts = resolveHumanDateTimeParts(nowMs, cfg);
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  if (opts?.compact) {
    return `${hh}${mm}`;
  }
  if (opts?.includeSeconds) {
    return `${hh}:${mm}:${String(parts.second).padStart(2, "0")}`;
  }
  return `${hh}:${mm}`;
}

export function resolveHumanResetCycleKey(
  nowMs: number,
  atHour: number,
  cfg?: OpenClawConfig,
): string {
  const parts = resolveHumanDateTimeParts(nowMs, cfg);
  const currentMinutes = parts.hour * 60 + parts.minute;
  return currentMinutes < atHour * 60 ? shiftDayKey(parts.dayKey, -1) : parts.dayKey;
}

export function resolveHumanResetBoundaryMs(
  nowMs: number,
  atHour: number,
  cfg?: OpenClawConfig,
): number | undefined {
  const timeZone = resolveHumanTimezone(cfg);
  const cycleKey = resolveHumanResetCycleKey(nowMs, atHour, cfg);
  const [year, month, day] = cycleKey.split("-").map(Number);
  const wallClockMs = Date.UTC(year, month - 1, day, atHour, 0, 0, 0);
  let guessMs = wallClockMs;

  // Re-run once or twice in case the target local time lands on a DST boundary.
  for (let index = 0; index < 3; index += 1) {
    const offsetMinutes = resolveShortOffsetMinutes(guessMs, timeZone);
    if (offsetMinutes === undefined || !Number.isFinite(offsetMinutes)) {
      return undefined;
    }
    const candidateMs = wallClockMs - offsetMinutes * 60_000;
    if (candidateMs === guessMs) {
      return candidateMs;
    }
    guessMs = candidateMs;
  }

  return undefined;
}
