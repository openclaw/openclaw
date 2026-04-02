import { resolveUserTimezone } from "../agents/date-time.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

function resolveActiveHoursTimezone(cfg: OpenClawConfig, raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "user") {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
  if (trimmed === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return host?.trim() || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
}

function parseActiveHoursTime(opts: { allow24: boolean }, raw?: string): number | null {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    if (!opts.allow24 || minute !== 0) {
      return null;
    }
    return 24 * 60;
  }
  return hour * 60 + minute;
}

function resolveMinutesInTimeZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isWithinWindow(currentMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) {
    return false;
  }
  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  return currentMin >= startMin || currentMin < endMin;
}

export function isWithinActiveHours(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
  nowMs?: number,
): boolean {
  const active = heartbeat?.activeHours;
  if (!active) {
    return true;
  }

  const startMin = parseActiveHoursTime({ allow24: false }, active.start);
  const endMin = parseActiveHoursTime({ allow24: true }, active.end);
  if (startMin === null || endMin === null) {
    return true;
  }
  if (startMin === endMin) {
    return false;
  }

  const timeZone = resolveActiveHoursTimezone(cfg, active.timezone);
  const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
  if (currentMin === null) {
    return true;
  }

  return isWithinWindow(currentMin, startMin, endMin);
}

/**
 * Returns the heartbeat interval in ms from the first matching schedule entry,
 * or `null` if no schedule is configured or no entry matches the current time.
 */
export function resolveScheduleIntervalMs(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
  nowMs?: number,
): number | null {
  const schedule = heartbeat?.schedule;
  if (!schedule || schedule.length === 0) {
    return null;
  }

  const timeZone = resolveActiveHoursTimezone(cfg, heartbeat?.activeHours?.timezone);
  const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
  if (currentMin === null) {
    return null;
  }

  for (const entry of schedule) {
    const startMin = parseActiveHoursTime({ allow24: false }, entry.start);
    const endMin = parseActiveHoursTime({ allow24: true }, entry.end);
    if (startMin === null || endMin === null) {
      continue;
    }
    if (isWithinWindow(currentMin, startMin, endMin)) {
      try {
        const ms = parseDurationMs(entry.every, { defaultUnit: "m" });
        return ms > 0 ? ms : null;
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Returns milliseconds until the next schedule window boundary (nearest future
 * `start` or `end` across all schedule entries), or `null` if no schedule is
 * configured. Used by the scheduler to wake at interval transitions.
 *
 * Note: uses fixed 24*60 minute arithmetic, which can be off by up to ~60 min
 * during DST transitions (23h or 25h days). This is acceptable because the
 * boundary timer is best-effort — the actual interval is always re-resolved
 * via resolveScheduleIntervalMs (which uses Intl.DateTimeFormat and handles
 * DST correctly) when the timer fires.
 */
export function resolveNextWindowBoundaryMs(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
  nowMs?: number,
): number | null {
  const schedule = heartbeat?.schedule;
  if (!schedule || schedule.length === 0) {
    return null;
  }

  const timeZone = resolveActiveHoursTimezone(cfg, heartbeat?.activeHours?.timezone);
  const now = nowMs ?? Date.now();
  const currentMin = resolveMinutesInTimeZone(now, timeZone);
  if (currentMin === null) {
    return null;
  }

  const MINUTES_IN_DAY = 24 * 60;
  let smallestDelta = Number.POSITIVE_INFINITY;

  for (const entry of schedule) {
    const startMin = parseActiveHoursTime({ allow24: false }, entry.start);
    const endMin = parseActiveHoursTime({ allow24: true }, entry.end);
    if (startMin === null || endMin === null) {
      continue;
    }
    for (const boundary of [startMin, endMin]) {
      if (boundary === currentMin) {
        continue;
      }
      const delta =
        boundary > currentMin ? boundary - currentMin : MINUTES_IN_DAY - currentMin + boundary;
      if (delta < smallestDelta) {
        smallestDelta = delta;
      }
    }
  }

  if (!Number.isFinite(smallestDelta)) {
    return null;
  }

  return smallestDelta * 60_000;
}
