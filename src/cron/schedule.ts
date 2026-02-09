import { Cron } from "croner";
import type { CronSchedule } from "./types.js";
import { parseAbsoluteTimeMs } from "./parse.js";

function resolveCronTimezone(tz?: string) {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (trimmed) {
    return trimmed;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  if (schedule.kind === "at") {
    // Handle both canonical `at` (string) and legacy `atMs` (number) fields.
    // The store migration should convert atMs→at, but be defensive in case
    // the migration hasn't run yet or was bypassed.
    const sched = schedule as { at?: string; atMs?: number | string };
    const atMs =
      typeof sched.atMs === "number" && Number.isFinite(sched.atMs) && sched.atMs > 0
        ? sched.atMs
        : typeof sched.atMs === "string"
          ? parseAbsoluteTimeMs(sched.atMs)
          : typeof sched.at === "string"
            ? parseAbsoluteTimeMs(sched.at)
            : null;
    if (atMs === null) {
      return undefined;
    }
    return atMs > nowMs ? atMs : undefined;
  }

  if (schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs));
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
    if (nowMs < anchor) {
      return anchor;
    }
    const elapsed = nowMs - anchor;
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
    return anchor + steps * everyMs;
  }

  const expr = schedule.expr.trim();
  if (!expr) {
    return undefined;
  }
  const cron = new Cron(expr, {
    timezone: resolveCronTimezone(schedule.tz),
    catch: false,
  });
  // Cron operates at second granularity, so floor nowMs to the start of the
  // current second.  This prevents the lookback from landing inside a matching
  // second — if nowMs is e.g. 12:00:00.500 and the pattern fires at second 0,
  // a 1ms lookback (12:00:00.499) is still *within* that second, causing
  // croner to skip ahead to the next occurrence (e.g. the following day).
  // Flooring first ensures the lookback always falls in the *previous* second.
  const nowSecondMs = Math.floor(nowMs / 1000) * 1000;
  const next = cron.nextRun(new Date(nowSecondMs - 1));
  if (!next) {
    return undefined;
  }
  const nextMs = next.getTime();
  return Number.isFinite(nextMs) && nextMs >= nowSecondMs ? nextMs : undefined;
}
