import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveDefaultCronStaggerMs } from "../../../../src/cron/stagger.js";
import { parseOffsetlessIsoDateTimeInTimeZone } from "../../../../src/infra/format-time/parse-offsetless-zoned-datetime.js";
import type { CronJob } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { parseCronDurationMs } from "./decimal.ts";
import type { CronFormState } from "./types.ts";

registerCronEnglish();

export function parseCronScheduleAt(input: string): string | undefined {
  const parsed = parseOffsetlessIsoDateTimeInTimeZone(
    input,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  return parsed.ok ? parsed.iso : undefined;
}

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
  if (
    staggerMs === 0 ||
    typeof staggerMs !== "number" ||
    !Number.isFinite(staggerMs) ||
    staggerMs < 0
  ) {
    return { scheduleExact: staggerMs === 0, staggerAmount: "", staggerUnit: "seconds" };
  }
  const minutes = staggerMs % 60_000 === 0;
  return {
    scheduleExact: false,
    staggerAmount: minutes ? String(staggerMs / 60_000) : durationMsToSecondsString(staggerMs),
    staggerUnit: minutes ? "minutes" : "seconds",
  };
}

function cronHourIndex(fields: string[]): number {
  return fields.length === 5 || fields.length === 6 ? fields.length - 4 : -1;
}

/** Read the range syntax the builder writes, without touching arbitrary cron hour fields. */
export function readCronHourRange(expr: string) {
  const fields = expr.trim().split(/\s+/u);
  const index = cronHourIndex(fields);
  const field = fields[index] ?? "";
  const daytime = /^(\d{1,2})-(\d{1,2})$/u.exec(field);
  const overnight = /^0-(\d{1,2}),(\d{1,2})-23$/u.exec(field);
  const from = Number(daytime?.[1] ?? overnight?.[2]);
  const last = Number(daytime?.[2] ?? overnight?.[1]);
  if (!(from <= 23 && last <= 23 && (daytime ? from <= last : last + 1 < from))) {
    return undefined;
  }
  fields[index] = "*";
  const clock = (hour: number) => String(hour).padStart(2, "0") + ":00";
  return { expr: fields.join(" "), start: clock(from), end: clock(last + 1) };
}

export function resolveScheduleWindow(form: CronFormState, source?: CronJob | null) {
  const previous = source?.schedule.kind === "cron" ? source.schedule : undefined;
  const savedHours = source?.activeHours;
  const timezone = form.cronTz.trim();
  const tz = timezone === "local" ? undefined : timezone || undefined;
  const result: { expr: string; tz: string | undefined; activeHours?: CronJob["activeHours"] } = {
    expr: form.cronExpr.trim(),
    tz,
  };
  if (!form.activeHoursEnabled) {
    return result;
  }
  const start = form.activeHoursStart;
  const end = form.activeHoursEnd;
  const native = previous && !savedHours ? readCronHourRange(previous.expr) : undefined;
  if (
    form.scheduleKind === "cron" &&
    previous &&
    native?.expr === result.expr &&
    native.start === start &&
    native.end === end
  ) {
    result.expr = previous.expr;
    return result;
  }
  // An elapsed interval has an anchor and does not reset at the hour or at DST.
  // Existing gates also affect manual runs and must not be silently converted.
  if (
    form.scheduleKind === "cron" &&
    !savedHours &&
    (native || (!form.staggerAmount.trim() && !form.triggerEnabled && !source?.pacing)) &&
    start.endsWith(":00") &&
    end.endsWith(":00") &&
    start !== end
  ) {
    const fields = result.expr.split(/\s+/u);
    const index = cronHourIndex(fields);
    if (fields[index] === "*") {
      const from = Number(start.slice(0, 2));
      const until = Number(end.slice(0, 2));
      fields[index] =
        until > from
          ? `${from}-${until - 1}`
          : until === 0
            ? `${from}-23`
            : `0-${until - 1},${from}-23`;
      result.expr = fields.join(" ");
      return result;
    }
  }
  const preserveZone =
    savedHours &&
    (form.scheduleKind === "cron" && previous
      ? timezone === (previous.tz ?? "")
      : timezone === (savedHours.timezone ?? "user"));
  result.activeHours = {
    start,
    end,
    timezone: preserveZone ? savedHours.timezone : timezone || "local",
  };
  return result;
}

export function hasUnchangedCronSchedule(form: CronFormState, job: CronJob): boolean {
  const schedule = job.schedule;
  if (form.scheduleKind !== schedule.kind) {
    return false;
  }
  if (schedule.kind === "event") {
    if (schedule.source !== "mcp-events") {
      return true;
    }
    try {
      return (
        form.eventServer.trim() === schedule.options.server &&
        form.eventName.trim() === schedule.options.name &&
        jsonSchemaValuesEqual(JSON.parse(form.eventArguments), schedule.options.arguments ?? {})
      );
    } catch {
      return false;
    }
  }
  if (schedule.kind === "at") {
    return form.scheduleAt === formatDateTimeLocal(schedule.at);
  }
  if (schedule.kind === "every") {
    return parseCronDurationMs(form.everyAmount, form.everyUnit) === schedule.everyMs;
  }
  if (schedule.kind === "cron") {
    const stagger = parseStaggerSchedule(schedule.staggerMs);
    const { expr, tz } = resolveScheduleWindow(form, job);
    return (
      expr === schedule.expr &&
      tz === schedule.tz &&
      form.scheduleExact === stagger.scheduleExact &&
      form.staggerAmount.trim() === stagger.staggerAmount &&
      form.staggerUnit === stagger.staggerUnit
    );
  }
  return true;
}

export function buildCronSchedule(form: CronFormState, source?: CronJob | null) {
  if (form.scheduleKind === "event") {
    const args: unknown = JSON.parse(form.eventArguments);
    if (!isRecord(args)) {
      throw new Error(t("cron.events.eventArgumentsInvalid"));
    }
    return {
      kind: "event" as const,
      source: "mcp-events",
      options: {
        server: form.eventServer.trim(),
        name: form.eventName.trim(),
        arguments: args,
      },
    };
  }
  if (form.scheduleKind === "at") {
    const at = parseCronScheduleAt(form.scheduleAt);
    if (!at) {
      throw new Error(t("cron.errors.invalidRunTime"));
    }
    return { kind: "at" as const, at };
  }
  if (form.scheduleKind === "every") {
    const everyMs = parseCronDurationMs(form.everyAmount, form.everyUnit);
    if (everyMs === undefined) {
      throw new Error(t("cron.errors.invalidIntervalAmount"));
    }
    return { kind: "every" as const, everyMs };
  }
  const { expr, tz } = resolveScheduleWindow(form, source);
  if (!expr) {
    throw new Error(t("cron.errors.cronExprRequiredShort"));
  }
  let staggerMs: number | undefined;
  const staggerAmount = form.staggerAmount.trim();
  if (form.scheduleExact) {
    staggerMs = 0;
  } else if (!staggerAmount) {
    // Same-expression updates preserve omitted windows; new defaults must stay unspecified.
    const previous = source?.schedule;
    const clearsSavedWindow =
      previous?.kind === "cron" && previous.expr === expr && previous.staggerMs !== undefined;
    staggerMs = resolveDefaultCronStaggerMs(expr) ?? (clearsSavedWindow ? 0 : undefined);
  } else {
    staggerMs = parseCronDurationMs(staggerAmount, form.staggerUnit, true);
    if (staggerMs === undefined) {
      throw new Error(t("cron.errors.invalidStaggerAmount"));
    }
  }
  return { kind: "cron" as const, expr, tz, staggerMs };
}
