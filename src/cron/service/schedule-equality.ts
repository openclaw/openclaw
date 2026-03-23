import { parseAbsoluteTimeMs } from "../parse.js";
import { coerceFiniteScheduleNumber } from "../schedule.js";
import { resolveCronStaggerMs } from "../stagger.js";
import type { CronJob } from "../types.js";

function normalizeCronExpr(expr: unknown): string | undefined {
  const trimmed = typeof expr === "string" ? expr.trim() : "";
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeCronTimezone(tz: unknown): string | undefined {
  const trimmed = typeof tz === "string" ? tz.trim() : "";
  if (trimmed) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    } catch {
      return trimmed;
    }
  }
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof localTimezone === "string" && localTimezone.trim()
    ? localTimezone.trim()
    : undefined;
}

function normalizeAtTimestamp(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseAbsoluteTimeMs(trimmed);
  return parsed === null ? trimmed : new Date(parsed).toISOString();
}

function normalizeScheduleNumber(value: unknown, minimum: number): string | undefined {
  const numeric = coerceFiniteScheduleNumber(value);
  if (numeric !== undefined) {
    return String(Math.max(minimum, Math.floor(numeric)));
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

export function schedulesEqual(a: CronJob["schedule"], b: CronJob["schedule"]): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "at" && b.kind === "at") {
    return normalizeAtTimestamp(a.at) === normalizeAtTimestamp(b.at);
  }
  if (a.kind === "every" && b.kind === "every") {
    return (
      normalizeScheduleNumber(a.everyMs, 1) === normalizeScheduleNumber(b.everyMs, 1) &&
      normalizeScheduleNumber(a.anchorMs, 0) === normalizeScheduleNumber(b.anchorMs, 0)
    );
  }
  if (a.kind === "cron" && b.kind === "cron") {
    return (
      normalizeCronExpr(a.expr) === normalizeCronExpr(b.expr) &&
      normalizeCronTimezone(a.tz) === normalizeCronTimezone(b.tz) &&
      resolveCronStaggerMs(a) === resolveCronStaggerMs(b)
    );
  }
  return false;
}
