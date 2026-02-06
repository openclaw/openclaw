import { Cron } from "croner";
import type { CronSchedule } from "./types.js";
import { parseAbsoluteTimeMs } from "./parse.js";

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
    timezone: schedule.tz?.trim() || undefined,
    catch: false,
  });
  const next = cron.nextRun(new Date(nowMs));
  if (!next) {
    return undefined;
  }
  const nextMs = next.getTime();
  
  // Guard against croner returning a timestamp in the past (issue #10035).
  // This can happen due to timezone/DST edge cases or croner bugs.
  // If the returned time is more than 1 day in the past, it's likely incorrect
  // (e.g., wrong year). Try getting the next occurrence after the buggy one.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (nextMs < nowMs - ONE_DAY_MS) {
    // Croner gave us a time significantly in the past. This is likely a bug.
    // Use enumerate to get the next few runs and find the first valid future time.
    const upcoming = cron.enumerate(10, new Date(nowMs));
    for (const run of upcoming) {
      const runMs = run.getTime();
      if (runMs >= nowMs) {
        return runMs;
      }
    }
    // If all enumerated times are in the past, return undefined
    return undefined;
  }
  
  return nextMs;
}
