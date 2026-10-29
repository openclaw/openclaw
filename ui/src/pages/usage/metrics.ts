import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { t } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import type { UsageTotals } from "./types.ts";

registerUsageEnglish();

const CHARS_PER_TOKEN = 4;
const DAY_MS = 86_400_000;
const costFormatters: Partial<Record<2 | 4 | 6, Intl.NumberFormat>> = {};
// These labels use the host realm's default locale, independently of the UI language.
let dayLabelFormatter: Intl.DateTimeFormat | undefined;
let fullDateFormatter: Intl.DateTimeFormat | undefined;

function charsToTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** A turn that ended before final usage leaves a known subtotal: show it as a lower bound. */
function atLeast(value: string, report?: UsageTotals["usageReport"]): string {
  return report?.state === "unavailable" ? t("usage.common.atLeast", { value }) : value;
}

function formatUsageTokens(n: number, report?: UsageTotals["usageReport"]): string {
  return atLeast(
    formatCompactTokenCount(n, { thousandsSuffix: "K", trimTrailingZero: false }),
    report,
  );
}

// Usage charts choose fixed precision from the surrounding scale; the shared
// adaptive cost formatter would change labels as values cross its thresholds.
function formatUsageCost(
  n: number,
  decimals: 2 | 4 | 6 = 2,
  report?: UsageTotals["usageReport"],
): string {
  const formatter = (costFormatters[decimals] ??= new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }));
  return atLeast(`$${formatter.format(n)}`, report);
}

export function formatAnalysisCost(value: number, report?: UsageTotals["usageReport"]): string {
  const magnitude = Math.abs(value);
  const decimals = magnitude === 0 || magnitude >= 0.01 ? 2 : magnitude >= 0.0001 ? 4 : 6;
  return formatUsageCost(value, decimals, report);
}

function formatHourLabel(hour: number): string {
  // The bucket hour is already zoned; a fixed UTC date avoids local DST normalization.
  const date = new Date(Date.UTC(1970, 0, 1, hour));
  return date.toLocaleTimeString(undefined, { hour: "numeric", timeZone: "UTC" });
}

function buildPeakErrorHours(hourMsgs: number[], hourErrors: number[]) {
  return hourMsgs
    .map((msgs, hour) => ({
      hour,
      msgs,
      errors: hourErrors[hour] ?? 0,
      rate: msgs > 0 ? (hourErrors[hour] ?? 0) / msgs : 0,
    }))
    .filter((entry) => entry.msgs > 0 && entry.errors > 0)
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map((entry) => ({
      label: formatHourLabel(entry.hour),
      value: `${(entry.rate * 100).toFixed(2)}%`,
      weight: entry.rate,
      sub: `${Math.round(entry.errors).toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${Math.round(entry.msgs).toLocaleString()} ${t("usage.overview.messagesAbbrev")}`,
    }));
}

function parseYmdDate(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    ? date
    : null;
}

function parseIsoDayIndex(dateStr: string): number | null {
  const date = parseYmdDate(dateStr);
  return date ? date.getTime() / DAY_MS : null;
}

function formatDayLabel(dateStr: string): string {
  const date = parseYmdDate(dateStr);
  if (!date) {
    return dateStr;
  }
  dayLabelFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return dayLabelFormatter.format(date);
}

function formatFullDate(dateStr: string): string {
  const date = parseYmdDate(dateStr);
  if (!date) {
    return dateStr;
  }
  fullDateFormatter ??= new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return fullDateFormatter.format(date);
}

function buildUsageCostWindows(
  daily: Array<UsageTotals & { date: string }>,
  rangeStartDate: string,
  rangeEndDate: string,
): {
  days: number;
  endDate: string;
  totals: UsageTotals;
}[] {
  const rangeStartDay = parseIsoDayIndex(rangeStartDate);
  const rangeEndDay = parseIsoDayIndex(rangeEndDate);
  if (rangeStartDay === null || rangeEndDay === null || rangeStartDay > rangeEndDay) {
    return [];
  }

  const rangeDays = rangeEndDay - rangeStartDay + 1;
  const windows = [rangeDays, ...[1, 7, 30, 90].filter((days) => days < rangeDays)].map((days) => ({
    days,
    endDate: rangeEndDate,
    totals: createEmptyCostUsageTotals(),
  }));
  for (const entry of daily) {
    const day = parseIsoDayIndex(entry.date);
    if (day === null || day < rangeStartDay || day > rangeEndDay) {
      continue;
    }
    const daysAgo = rangeEndDay - day;
    for (const window of windows) {
      if (daysAgo < window.days) {
        addCostUsageTotals(window.totals, entry);
      }
    }
  }
  return windows;
}

type UsageInsightStats = {
  durationCount: number;
  avgDurationMs: number;
  throughputTokensPerMin?: number;
  throughputCostPerMin?: number;
  errorRate: number;
};

export type { UsageInsightStats };
export {
  buildUsageCostWindows,
  buildPeakErrorHours,
  charsToTokens,
  formatUsageCost,
  formatDayLabel,
  formatFullDate,
  formatUsageTokens,
};
