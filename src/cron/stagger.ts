import type { CronSchedule } from "./types.js";

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string) {
  return expr.trim().split(/\s+/).filter(Boolean);
}

/**
 * Returns true when the minute field includes minute 0 as a firing point.
 * Does not match wildcard ("*") since every-minute crons don't benefit from
 * top-of-hour stagger — they already fire 60 times per hour.
 */
function minuteFieldIncludesZero(field: string): boolean {
  if (field === "0") {
    return true;
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    // step=1 is equivalent to "*" — skip stagger for every-minute expressions
    return Number.isFinite(step) && step > 1;
  }
  if (field.includes(",")) {
    return field.split(",").some((v) => v.trim() === "0");
  }
  if (field.includes("-")) {
    const [start] = field.split("-").map(Number);
    return start === 0;
  }
  return parseInt(field, 10) === 0;
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
