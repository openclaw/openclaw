import type { CronSchedule } from "./types.js";

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string) {
  return expr.trim().split(/\s+/).filter(Boolean);
}

/**
 * Check if a cron minute field would fire at minute 0 (top of the hour).
 * Handles:
 * - Exact "0"
 * - Wildcard "*" or step "* /N" (fires at 0 for any divisor)
 * - List "0,30" (fires at 0 if 0 is in the list)
 * - Range "0-5" (fires at 0 if range starts at 0)
 */
function minuteFieldIncludesZero(field: string): boolean {
  const trimmed = field.trim();
  if (trimmed === "0" || trimmed === "*") {
    return true;
  }
  // Step expression: */N or 0/N — both fire at minute 0
  if (/^\*\/\d+$/.test(trimmed) || /^0\/\d+$/.test(trimmed)) {
    return true;
  }
  // List expression: check if any element is "0"
  if (trimmed.includes(",")) {
    return trimmed.split(",").some((part) => part.trim() === "0");
  }
  // Range expression: N-M — fires at 0 if N is 0
  const rangeMatch = trimmed.match(/^(\d+)-\d+$/);
  if (rangeMatch?.[1] === "0") {
    return true;
  }
  // Range with step: N-M/S — fires at 0 if N is 0
  const rangeStepMatch = trimmed.match(/^(\d+)-\d+\/\d+$/);
  if (rangeStepMatch?.[1] === "0") {
    return true;
  }
  return false;
}

export function isRecurringTopOfHourCronExpr(expr: string) {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteFieldIncludesZero(minuteField) && hourField.includes("*");
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return secondField === "0" && minuteFieldIncludesZero(minuteField) && hourField.includes("*");
  }
  return false;
}

export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(0, Math.floor(numeric));
}

export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

export function resolveCronStaggerMs(schedule: Extract<CronSchedule, { kind: "cron" }>): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) {
    return explicit;
  }
  const expr = (schedule as { expr?: unknown }).expr;
  const cronExpr = typeof expr === "string" ? expr : "";
  return resolveDefaultCronStaggerMs(cronExpr) ?? 0;
}
