/** Leaf cron parsing contract shared by config validation, CLI, and scheduling. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Cron } from "croner";

export function resolveCronTimezone(tz?: string) {
  const trimmed = normalizeOptionalString(tz) ?? "";
  if (trimmed) {
    return trimmed;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Checks for a cron pattern under the same croner rules the scheduler applies,
 * excluding absolute timestamps that croner also accepts as one-shot schedules.
 */
export function isValidCronExpression(expr: string, timezone?: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return (
      new Cron(trimmed, { timezone: resolveCronTimezone(timezone), catch: false }).getPattern() !==
      undefined
    );
  } catch {
    return false;
  }
}
