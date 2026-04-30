import { Cron } from "croner";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type CronExpressionValidationError = {
  ok: false;
  message: string;
};

export type CronExpressionValidationSuccess = {
  ok: true;
};

export type CronExpressionValidationResult =
  | CronExpressionValidationSuccess
  | CronExpressionValidationError;

/**
 * Validates cron expression syntax before applying to job state.
 * This prevents invalid cron expressions from being persisted in disabled jobs
 * that would fail when enabled later.
 *
 * Uses croner library (same as computeNextRunAtMs) to validate the expression.
 *
 * @param expr - The cron expression to validate (e.g., "* * * * *" or "0 0 * * *")
 * @param tz - Optional timezone (defaults to system timezone)
 * @returns Validation result with ok boolean and error message if invalid
 */
export function validateCronExpression(
  expr: unknown,
  tz?: unknown,
): CronExpressionValidationResult {
  const exprRaw = normalizeOptionalString(expr) ?? "";
  if (!exprRaw) {
    return {
      ok: false,
      message: "cron expression is required",
    };
  }

  const exprTrimmed = exprRaw.trim();
  if (!exprTrimmed) {
    return {
      ok: false,
      message: "cron expression cannot be empty",
    };
  }

  const timezone = normalizeOptionalString(tz) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    // croner throws RangeError for invalid expressions like "* * * 13 *"
    new Cron(exprTrimmed, { timezone, catch: false });
    return { ok: true };
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : `Invalid cron expression: ${String(error)}`;
    return {
      ok: false,
      message: errorMessage,
    };
  }
}