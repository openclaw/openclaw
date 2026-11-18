/**
 * Reads and writes the schedule sentence ("Daily · on Weekdays · at 9:00 AM")
 * on top of the existing form schedule. Only cron expressions the sentence can
 * say exactly are translated; everything else stays a Custom expression.
 */
import type { CronFormState } from "../../lib/cron/types.ts";

export type SentenceFrequency =
  | "once"
  | "every"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

export type CronSentence =
  | { frequency: "hourly"; days: number[]; hours: { from: number; until: number } | null }
  | { frequency: "daily"; days: number[]; hour: number; minute: number }
  | { frequency: "weekly"; day: number; hour: number; minute: number }
  | { frequency: "monthly"; dayOfMonth: number; hour: number; minute: number };

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const WEEKEND = [0, 6] as const;

function integer(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^\d{1,2}$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

function parseDays(field: string | undefined): number[] | null {
  if (field === undefined) {
    return null;
  }
  if (field === "*") {
    return [...ALL_DAYS];
  }
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/u.exec(part);
    if (range) {
      const from = integer(range[1], 0, 7);
      const until = integer(range[2], 0, 7);
      if (from === null || until === null || from >= until) {
        return null;
      }
      for (let day = from; day <= until; day += 1) {
        days.add(day % 7);
      }
      continue;
    }
    const day = integer(part, 0, 7);
    if (day === null) {
      return null;
    }
    days.add(day % 7);
  }
  return [...days].toSorted((a, b) => a - b);
}

/** Days as cron writes them: `*`, runs of three or more as ranges, the rest listed. */
export function formatDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].toSorted((a, b) => a - b);
  if (sorted.length === 0 || sorted.length === ALL_DAYS.length) {
    return "*";
  }
  const parts: string[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) {
      end += 1;
    }
    if (end - start >= 2) {
      parts.push(`${sorted[start]}-${sorted[end]}`);
    } else {
      for (let index = start; index <= end; index += 1) {
        parts.push(String(sorted[index]));
      }
    }
    start = end + 1;
  }
  return parts.join(",");
}

/** The sentence for a five-field cron expression, or null when only Custom can say it. */
export function parseCronSentence(expression: string): CronSentence | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return null;
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== "*") {
    return null;
  }
  const minute = integer(minuteField, 0, 59);
  const days = parseDays(dowField);
  if (minute === null || days === null) {
    return null;
  }
  const window = /^(\d{1,2})-(\d{1,2})$/u.exec(hourField ?? "");
  if (hourField === "*" || window) {
    if (minute !== 0 || domField !== "*") {
      return null;
    }
    if (!window) {
      return { frequency: "hourly", days, hours: null };
    }
    const from = integer(window[1], 0, 23);
    const until = integer(window[2], 0, 23);
    if (from === null || until === null || from >= until) {
      return null;
    }
    return { frequency: "hourly", days, hours: { from, until } };
  }
  const hour = integer(hourField, 0, 23);
  if (hour === null) {
    return null;
  }
  if (domField !== "*") {
    const dayOfMonth = integer(domField, 1, 31);
    if (dayOfMonth === null || dowField !== "*") {
      return null;
    }
    return { frequency: "monthly", dayOfMonth, hour, minute };
  }
  if (days.length === 1) {
    return { frequency: "weekly", day: days[0]!, hour, minute };
  }
  return { frequency: "daily", days, hour, minute };
}

/** The cron expression a sentence stands for. */
export function formatCronSentence(sentence: CronSentence): string {
  switch (sentence.frequency) {
    case "hourly": {
      const hours = sentence.hours ? `${sentence.hours.from}-${sentence.hours.until}` : "*";
      return `0 ${hours} * * ${formatDays(sentence.days)}`;
    }
    case "daily":
      return `${sentence.minute} ${sentence.hour} * * ${formatDays(sentence.days)}`;
    case "weekly":
      return `${sentence.minute} ${sentence.hour} * * ${sentence.day}`;
    default:
      return `${sentence.minute} ${sentence.hour} ${sentence.dayOfMonth} * *`;
  }
}

/** The frequency a form reads as, or null for kinds that keep their own controls. */
export function formSentenceFrequency(
  form: Pick<CronFormState, "scheduleKind" | "cronExpr">,
): SentenceFrequency | null {
  switch (form.scheduleKind) {
    case "at":
      return "once";
    case "every":
      return "every";
    case "cron":
      return parseCronSentence(form.cronExpr)?.frequency ?? "custom";
    default:
      return null;
  }
}

const DEFAULT_TIME = { hour: 9, minute: 0 };

function sentenceDays(current: CronSentence | null): number[] {
  if (!current) {
    return [...ALL_DAYS];
  }
  if (current.frequency === "weekly") {
    return [current.day];
  }
  return "days" in current ? current.days : [...ALL_DAYS];
}

/** The cron sentence a frequency starts from, keeping what the current one already says. */
export function sentenceForFrequency(
  frequency: CronSentence["frequency"],
  current: CronSentence | null,
): CronSentence {
  const time =
    current && "hour" in current ? { hour: current.hour, minute: current.minute } : DEFAULT_TIME;
  const days = sentenceDays(current);
  switch (frequency) {
    case "hourly":
      return { frequency, days, hours: current?.frequency === "hourly" ? current.hours : null };
    case "daily":
      return { frequency, days, ...time };
    case "weekly":
      return {
        frequency,
        day:
          current?.frequency === "weekly"
            ? current.day
            : days.length < ALL_DAYS.length
              ? (days[0] ?? 1)
              : 1,
        ...time,
      };
    default:
      return {
        frequency: frequency satisfies "monthly",
        dayOfMonth: current?.frequency === "monthly" ? current.dayOfMonth : 1,
        ...time,
      };
  }
}

/** The form patch for choosing a schedule kind, with the delete-after-run default each kind carries. */
export function scheduleKindPatch(
  form: Pick<CronFormState, "scheduleKind">,
  value: CronFormState["scheduleKind"],
): Partial<CronFormState> {
  return {
    scheduleKind: value,
    ...(value === "event" ? { triggerEnabled: false, deleteAfterRun: false } : {}),
    ...(value === "at" && (form.scheduleKind === "every" || form.scheduleKind === "cron")
      ? { deleteAfterRun: true }
      : value === "every" || value === "cron"
        ? { deleteAfterRun: false }
        : {}),
  };
}
