import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { t } from "../../i18n/index.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import {
  createMsFormatter,
  formatCompactTokenCount,
  formatUsd,
  formatTimeMs,
} from "../../lib/format.ts";
import type { UsageTotals } from "./types.ts";

registerUsageEnglish();

const CHARS_PER_TOKEN = 4;
const DAY_MS = 86_400_000;
const dayLabelFormatter = createMsFormatter({ month: "short", day: "numeric", timeZone: "UTC" });
const fullDateFormatter = createMsFormatter({
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function charsToTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function formatUsageTokens(n: number): string {
  return formatCompactTokenCount(n, { thousandsSuffix: "K", trimTrailingZero: false });
}

// Usage charts choose fixed precision from the surrounding scale; the shared
// adaptive cost formatter would change labels as values cross its thresholds.
function formatUsageCost(n: number, decimals: 2 | 4 | 6 = 2): string {
  return formatUsd(n, decimals);
}

// Usage with no known price is unpriced, never free; a genuine zero stays $0.00.
function formatHeadlineCost(totals: UsageTotals): string {
  return totals.totalCost === 0 && totals.missingCostEntries > 0
    ? t("usage.overview.unpriced")
    : formatUsageCost(totals.totalCost);
}

export function formatAnalysisCost(value: number): string {
  const magnitude = Math.abs(value);
  const decimals = magnitude === 0 || magnitude >= 0.01 ? 2 : magnitude >= 0.0001 ? 4 : 6;
  return formatUsageCost(value, decimals);
}

function formatHourLabel(hour: number): string {
  // The bucket hour is already zoned; a fixed UTC date avoids local DST normalization.
  const date = new Date(Date.UTC(1970, 0, 1, hour));
  return formatTimeMs(date.getTime(), { hour: "numeric", timeZone: "UTC" });
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
  return dayLabelFormatter(date.getTime());
}

function formatFullDate(dateStr: string): string {
  const date = parseYmdDate(dateStr);
  if (!date) {
    return dateStr;
  }
  return fullDateFormatter(date.getTime());
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

/**
 * Active time for the current scope. Day selections narrow totals to those
 * days, so the denominator must come from the matching dailyLatency buckets;
 * without a day selection the full-range aggregate is already scoped right.
 */
export function usageActiveMs(
  input: {
    latency?: { count: number; avgMs: number };
    dailyLatency?: ReadonlyArray<{ date: string; count: number; avgMs: number }>;
  },
  selectedDays: readonly string[],
): number {
  if (selectedDays.length > 0 && input.dailyLatency?.length) {
    const days = new Set(selectedDays);
    let activeMs = 0;
    for (const day of input.dailyLatency) {
      if (days.has(day.date) && day.count > 0) {
        activeMs += day.avgMs * day.count;
      }
    }
    return activeMs;
  }
  const { latency } = input;
  return latency && latency.count > 0 ? latency.avgMs * latency.count : 0;
}

/**
 * Throughput divides by active time — the assistant-turn durations already
 * shipped in aggregates.latency — not the wall-clock session span, which also
 * counts every idle gap between turns.
 */
export function usageThroughputStats(input: {
  totals: { totalTokens: number; totalCost: number } | null;
  activeMs: number;
}): { throughputTokensPerMin?: number; throughputCostPerMin?: number } {
  const { totals, activeMs } = input;
  return {
    throughputTokensPerMin:
      totals && activeMs > 0 ? totals.totalTokens / (activeMs / 60000) : undefined,
    throughputCostPerMin:
      totals && activeMs > 0 ? totals.totalCost / (activeMs / 60000) : undefined,
  };
}

export type { UsageInsightStats };
export {
  buildUsageCostWindows,
  buildPeakErrorHours,
  charsToTokens,
  formatUsageCost,
  formatDayLabel,
  formatFullDate,
  formatHeadlineCost,
  formatUsageTokens,
};
