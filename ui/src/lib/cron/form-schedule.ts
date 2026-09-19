import type { CronJob } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { parseCronDurationMs } from "./decimal.ts";
import type { CronFormState } from "./types.ts";

export function formatDateTimeLocal(input: string): string {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

// Render everyMs back to the largest unit that divides it exactly, falling through
// to decimal seconds. Sub-second remainders are built from BigInt quotient/remainder,
// not float division, so every accepted millisecond round-trips losslessly
// through parseCronDurationMs when the job is resaved.
export function parseEverySchedule(
  everyMs: number,
): Pick<CronFormState, "everyAmount" | "everyUnit"> {
  if (everyMs % 86_400_000 === 0) {
    return { everyAmount: String(everyMs / 86_400_000), everyUnit: "days" };
  }
  if (everyMs % 3_600_000 === 0) {
    return { everyAmount: String(everyMs / 3_600_000), everyUnit: "hours" };
  }
  if (everyMs % 60_000 === 0) {
    return { everyAmount: String(everyMs / 60_000), everyUnit: "minutes" };
  }
  return { everyAmount: durationMsToSecondsString(everyMs), everyUnit: "seconds" };
}

export function durationMsToSecondsString(ms: number): string {
  const value = BigInt(ms);
  const whole = value / 1_000n;
  const remainder = value % 1_000n;
  if (remainder === 0n) {
    return String(whole);
  }
  const fractional = remainder.toString().padStart(3, "0").replace(/0+$/u, "");
  return `${whole}.${fractional}`;
}

export function parseStaggerSchedule(
  staggerMs?: number,
): Pick<CronFormState, "scheduleExact" | "staggerAmount" | "staggerUnit"> {
  if (staggerMs === 0) {
    return { scheduleExact: true, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (typeof staggerMs !== "number" || !Number.isFinite(staggerMs) || staggerMs < 0) {
    return { scheduleExact: false, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (staggerMs % 60_000 === 0) {
    return {
      scheduleExact: false,
      staggerAmount: String(staggerMs / 60_000),
      staggerUnit: "minutes",
    };
  }
  return {
    scheduleExact: false,
    staggerAmount: durationMsToSecondsString(staggerMs),
    staggerUnit: "seconds",
  };
}

export function hasUnchangedCronSchedule(form: CronFormState, job: CronJob): boolean {
  const schedule = job.schedule;
  if (form.scheduleKind !== schedule.kind) {
    return false;
  }
  if (schedule.kind === "at") {
    return form.scheduleAt === formatDateTimeLocal(schedule.at);
  }
  if (schedule.kind === "every") {
    return parseCronDurationMs(form.everyAmount, form.everyUnit) === schedule.everyMs;
  }
  if (schedule.kind === "cron") {
    const stagger = parseStaggerSchedule(schedule.staggerMs);
    return (
      form.cronExpr.trim() === schedule.expr &&
      form.cronTz.trim() === (schedule.tz ?? "") &&
      form.scheduleExact === stagger.scheduleExact &&
      form.staggerAmount.trim() === stagger.staggerAmount &&
      form.staggerUnit === stagger.staggerUnit
    );
  }
  return true;
}

export function buildCronSchedule(form: CronFormState) {
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      throw new Error(t("cron.errors.invalidRunTime"));
    }
    return { kind: "at" as const, at: new Date(ms).toISOString() };
  }
  if (form.scheduleKind === "every") {
    const everyMs = parseCronDurationMs(form.everyAmount, form.everyUnit);
    if (everyMs === undefined) {
      throw new Error(t("cron.errors.invalidIntervalAmount"));
    }
    return { kind: "every" as const, everyMs };
  }
  const expr = form.cronExpr.trim();
  if (!expr) {
    throw new Error(t("cron.errors.cronExprRequiredShort"));
  }
  if (form.scheduleExact) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs: 0 };
  }
  const staggerAmount = form.staggerAmount.trim();
  if (!staggerAmount) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
  }
  const staggerMs = parseCronDurationMs(staggerAmount, form.staggerUnit, true);
  if (staggerMs === undefined) {
    throw new Error(t("cron.errors.invalidStaggerAmount"));
  }
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs };
}
