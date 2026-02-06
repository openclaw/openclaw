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
  // If the returned time is in the past, find the next valid future occurrence.
  if (nextMs < nowMs) {
    // Croner gave us a past time. Keep calling nextRun() until we get a future time.
    let futureDate: Date | null = next;
    let attempts = 0;
    const maxAttempts = 100; // Safety limit to prevent infinite loops

    while (futureDate && futureDate.getTime() < nowMs && attempts < maxAttempts) {
      futureDate = cron.nextRun(futureDate);
      attempts++;
    }

    if (!futureDate || futureDate.getTime() < nowMs) {
      // Still in the past after all attempts, return undefined
      return undefined;
    }

    return futureDate.getTime();
  }

  return nextMs;
}
