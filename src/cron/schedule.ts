import { Cron } from "croner";
import { parseAbsoluteTimeMs } from "./parse.js";
import type { CronSchedule } from "./types.js";

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

  const cronSchedule = schedule as { expr?: unknown; cron?: unknown };
  const exprSource = typeof cronSchedule.expr === "string" ? cronSchedule.expr : cronSchedule.cron;
  if (typeof exprSource !== "string") {
    throw new Error("invalid cron schedule: expr is required");
  }
  const expr = exprSource.trim();
  if (!expr) {
    return undefined;
  }
  const cron = new Cron(expr, {
    timezone: resolveCronTimezone(schedule.tz),
    catch: false,
  });
  let next = cron.nextRun(new Date(nowMs));
  if (!next) {
    return undefined;
  }
  let nextMs = next.getTime();
  if (!Number.isFinite(nextMs)) {
    return undefined;
  }

  // Workaround for croner year-rollback bug: some timezone/date combinations
  // (e.g. Asia/Shanghai) cause nextRun to return a timestamp in a past year.
  // Retry from a later reference point when the returned time is not in the
  // future.
  if (nextMs <= nowMs) {
    const nextSecondMs = Math.floor(nowMs / 1000) * 1000 + 1000;
    const retry = cron.nextRun(new Date(nextSecondMs));
    if (retry) {
      const retryMs = retry.getTime();
      if (Number.isFinite(retryMs) && retryMs > nowMs) {
        return retryMs;
      }
    }
    // Still in the past — try from start of tomorrow (UTC) as a broader reset.
    const tomorrowMs = new Date(nowMs).setUTCHours(24, 0, 0, 0);
    const retry2 = cron.nextRun(new Date(tomorrowMs));
    if (retry2) {
      const retry2Ms = retry2.getTime();
      if (Number.isFinite(retry2Ms) && retry2Ms > nowMs) {
        return retry2Ms;
      }
    }
    return undefined;
  }

  return nextMs;
}
