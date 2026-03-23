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

export function schedulesEqual(a: CronJob["schedule"], b: CronJob["schedule"]): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "at" && b.kind === "at") {
    return a.at === b.at;
  }
  if (a.kind === "every" && b.kind === "every") {
    return a.everyMs === b.everyMs && a.anchorMs === b.anchorMs;
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
