// Evaluates heartbeat active-hours windows.
import { resolveUserTimezone } from "../agents/date-time.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";

// Heartbeat active-hours helpers interpret user/local/IANA timezones and treat
// invalid config as permissive so bad schedules do not disable heartbeats.
const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

/** Resolve the formatter used to evaluate heartbeat active hours. */
function resolveActiveHoursFormatter(
  cfg: OpenClawConfig,
  raw?: string,
): Intl.DateTimeFormat | null {
  let timeZone = raw?.trim();
  const isExplicit = timeZone && timeZone !== "user" && timeZone !== "local";
  if (!timeZone || timeZone === "user") {
    timeZone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  } else if (timeZone === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    timeZone = host?.trim() || "UTC";
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return isExplicit ? resolveActiveHoursFormatter(cfg) : null;
  }
}

function parseActiveHoursTime(opts: { allow24: boolean }, raw?: string): number | null {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  return hour === 24 && !opts.allow24 ? null : hour * 60 + minute;
}

function resolveMinutesInTimeZone(nowMs: number, formatter: Intl.DateTimeFormat): number | null {
  try {
    const parts = formatter.formatToParts(new Date(nowMs));
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

/** Return true when the current time is inside the configured heartbeat window. */
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

  const formatter = resolveActiveHoursFormatter(cfg, active.timezone);
  if (!formatter) {
    return true;
  }

  const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), formatter);
  if (currentMin === null) {
    return true;
  }
  return endMin > startMin
    ? currentMin >= startMin && currentMin < endMin
    : currentMin >= startMin || currentMin < endMin;
}
