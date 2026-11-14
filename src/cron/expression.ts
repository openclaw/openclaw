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
 * Checks whether a cron expression parses under the same croner rules the scheduler
 * applies, so callers can reject expressions the scheduler would throw on later.
 */
export function isValidCronExpression(expr: string, timezone?: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) {
    return false;
  }
  try {
    void new Cron(trimmed, { timezone: resolveCronTimezone(timezone), catch: false });
    return true;
  } catch {
    return false;
  }
}
