import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import {
  formatUsageCost,
  formatAnalysisCost,
  formatUsageTokens,
  formatDayLabel,
  formatFullDate,
} from "./metrics.ts";
import type { CostDailyEntry, UsageProps, UsageTotals } from "./types.ts";

function tokenCategory<Key extends "output" | "input" | "cacheWrite" | "cacheRead">(
  key: Key,
  hintKey: string,
  short: string,
) {
  return {
    key,
    className: `usage-token-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    labelKey: `usage.breakdown.${key}`,
    hintKey,
    short,
  };
}

export const USAGE_TOKEN_CATEGORIES = [
  tokenCategory("output", "usage.details.assistantOutputTokens", "Out"),
  tokenCategory("input", "usage.details.userToolInputTokens", "In"),
  tokenCategory("cacheWrite", "usage.details.tokensWrittenToCache", "CW"),
  tokenCategory("cacheRead", "usage.details.tokensReadFromCache", "CR"),
] as const;

function pct(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

function handleDailyBarKeydown(
  event: KeyboardEvent,
  day: string,
  orderedDays: string[],
  onSelectDay: UsageProps["callbacks"]["filters"]["onSelectDay"],
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  onSelectDay(day, event.shiftKey, orderedDays);
}

type UsageChartRange = { startDate: string; endDate: string; complete: boolean };

function calendarDaily(daily: CostDailyEntry[], range: UsageChartRange): CostDailyEntry[] {
  const start = Date.parse(range.startDate);
  const end = Date.parse(range.endDate);
  const days = (end - start) / 86_400_000 + 1;
  // Missing buckets are known zero only after the report is complete. Keep
  // long historical ranges bounded instead of creating decades of empty bars.
  if (!range.complete || !Number.isInteger(days) || days < 1 || days > 366) {
    return daily.toSorted((a, b) => a.date.localeCompare(b.date));
  }
  const recorded = new Map(daily.map((day) => [day.date, day]));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    return recorded.get(date) ?? { ...createEmptyCostUsageTotals(), date };
  });
}

export function renderDailyChartCompact(
  dailyEntries: CostDailyEntry[],
  selectedDays: string[],
  chartMode: "tokens" | "cost",
  dailyChartMode: "total" | "by-type",
  onDailyChartModeChange: (mode: "total" | "by-type") => void,
  onSelectDay: UsageProps["callbacks"]["filters"]["onSelectDay"],
  range: UsageChartRange,
) {
  const daily = calendarDaily(dailyEntries, range);
  if (!daily.length) {
    return html`
      <div class="daily-chart-compact">
        <div class="card-title usage-section-title">${t("usage.daily.title")}</div>
        <div class="usage-empty-block">${t("usage.empty.noData")}</div>
      </div>
    `;
  }

  const orderedDays = daily.map((entry) => entry.date);
  const isTokenMode = chartMode === "tokens";
  const values = daily.map((d) => (isTokenMode ? d.totalTokens : d.totalCost));
  const scaleMaximum = Math.max(...values, 0);
  const maxValue = scaleMaximum > 0 ? scaleMaximum : isTokenMode ? 1 : 0.0001;

  // Adaptive scaling: when the spread between largest and smallest non-zero
  // values is extreme (>50×), use square-root compression so small bars stay
  // visible instead of collapsing to a single pixel.
  const nonZero = values.filter((v) => v > 0);
  const minNonZero = nonZero.length > 0 ? Math.min(...nonZero) : maxValue;
  const spread = maxValue / minNonZero;
  const usesCompressedScale = spread > 50;
  const chartAreaPx = 200;
  const minBarPx = 6;
  const barHeights = values.map((v): number => {
    if (v <= 0) {
      return 0;
    }
    const ratio = usesCompressedScale ? Math.sqrt(v / maxValue) : v / maxValue;
    return Math.max(minBarPx, ratio * chartAreaPx);
  });

  // Calculate bar width based on number of days
  const barMaxWidth = daily.length > 30 ? 12 : daily.length > 20 ? 18 : daily.length > 14 ? 24 : 32;
  const showTotals = daily.length <= 14;
  const selectedDaySet = new Set(selectedDays);

  return html`
    <div class="daily-chart-compact">
      <div class="daily-chart-header">
        ${renderSettingsSegmented({
          mode: "buttons",
          variant: "accent",
          className: "small sessions-toggle",
          value: dailyChartMode,
          onChange: onDailyChartModeChange,
          onReselect: onDailyChartModeChange,
          options: [
            { value: "total", label: t("usage.daily.total") },
            { value: "by-type", label: t("usage.daily.byType") },
          ],
        })}
        <div class="card-title">
          ${isTokenMode ? t("usage.daily.tokensTitle") : t("usage.daily.costTitle")}
          <div class="card-sub daily-chart-range">
            ${formatFullDate(range.startDate)} – ${formatFullDate(range.endDate)}
          </div>
          ${
            usesCompressedScale
              ? html`<span
                  class="daily-chart-scale-badge"
                  title=${t("usage.daily.compressedScaleHint")}
                  aria-label=${t("usage.daily.compressedScaleHint")}
                  >√</span
                >`
              : nothing
          }
        </div>
      </div>
      <div class="daily-chart">
        <div class="daily-chart-plot">
          <div class="daily-chart-scale" aria-hidden="true">
            ${(scaleMaximum > 0
              ? [scaleMaximum, scaleMaximum / (usesCompressedScale ? 4 : 2), 0]
              : [0]
            ).map(
              (value) =>
                html`<span
                  >${
                    isTokenMode
                      ? formatUsageTokens(value)
                      : value === 0
                        ? formatUsageCost(0)
                        : formatAnalysisCost(value)
                  }</span
                >`,
            )}
          </div>
          <div class="daily-chart-bars" style="--bar-max-width: ${barMaxWidth}px">
            ${daily.map((d, idx) => {
              const heightPx = expectDefined(barHeights[idx], "daily usage bar height");
              const isSelected = selectedDaySet.has(d.date);
              const label = formatDayLabel(d.date);
              // Shorter label for many days (just day number)
              const showDateLabel =
                daily.length <= 14 ||
                idx % Math.ceil(daily.length / 6) === 0 ||
                idx === daily.length - 1;
              const shortLabel = label;
              const labelClass = showDateLabel
                ? "daily-bar-label"
                : "daily-bar-label daily-bar-label--hidden";
              const segments =
                dailyChartMode === "by-type"
                  ? USAGE_TOKEN_CATEGORIES.map(({ key, className, labelKey }) => ({
                      value: isTokenMode ? d[key] : (d[`${key}Cost`] ?? 0),
                      className,
                      labelKey,
                    }))
                  : [];
              const breakdownLines = segments.map(
                ({ value, labelKey }) =>
                  `${t(labelKey)} ${isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value)}`,
              );
              const totalLabel = isTokenMode
                ? formatUsageTokens(d.totalTokens)
                : formatAnalysisCost(d.totalCost);
              const dateLabel = formatFullDate(d.date);
              const tokensLabel =
                `${formatUsageTokens(d.totalTokens)} ${normalizeLowercaseStringOrEmpty(
                  t("usage.metrics.tokens"),
                )}`.trim();
              const costLabel = formatAnalysisCost(d.totalCost);
              const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
              return html`
                <openclaw-tooltip
                  .content=${[dateLabel, tokensLabel, costLabel, ...breakdownLines].join("\n")}
                >
                  <div
                    class="daily-bar-wrapper ${isSelected ? "selected" : ""}"
                    role="button"
                    tabindex="0"
                    aria-pressed=${isSelected ? "true" : "false"}
                    aria-label=${`${dateLabel}: ${tokensLabel}, ${costLabel}`}
                    @keydown=${(e: KeyboardEvent) => handleDailyBarKeydown(e, d.date, orderedDays, onSelectDay)}
                    @click=${(e: MouseEvent) => onSelectDay(d.date, e.shiftKey, orderedDays)}
                  >
                    ${
                      dailyChartMode === "by-type"
                        ? html`
                            <div
                              class="daily-bar daily-bar--stacked ${heightPx === 0 ? "daily-bar--empty" : ""}"
                              style="height: ${heightPx.toFixed(0)}px;"
                            >
                              ${segments.map(
                                ({ className, value }) => html`
                                  <div
                                    class="cost-segment ${className}"
                                    style="height: ${(value / segmentTotal) * 100}%"
                                  ></div>
                                `,
                              )}
                            </div>
                          `
                        : html`
                            <div
                              class="daily-bar ${heightPx === 0 ? "daily-bar--empty" : ""}"
                              style="height: ${heightPx.toFixed(0)}px"
                            ></div>
                          `
                    }
                    ${
                      showTotals
                        ? html`<div class="daily-bar-total">${totalLabel}</div>`
                        : html`<div
                            class="daily-bar-total daily-bar-total--placeholder"
                            aria-hidden="true"
                          ></div>`
                    }
                    <div class="${labelClass}">${shortLabel}</div>
                  </div>
                </openclaw-tooltip>
              `;
            })}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderCostBreakdownCompact(totals: UsageTotals, mode: "tokens" | "cost") {
  const isTokenMode = mode === "tokens";
  const total = isTokenMode ? totals.totalTokens || 1 : totals.totalCost || 0;
  const categories = USAGE_TOKEN_CATEGORIES.map(({ key, className, labelKey }) => {
    const value = isTokenMode ? totals[key] : totals[`${key}Cost`] || 0;
    return {
      className,
      labelKey,
      percentage: pct(value, total),
      formatted: isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value),
    };
  });

  return html`
    <div class="cost-breakdown cost-breakdown-compact">
      <div class="cost-breakdown-header">
        ${isTokenMode ? t("usage.breakdown.tokensByType") : t("usage.breakdown.costByType")}
      </div>
      <div class="cost-breakdown-bar">
        ${categories.map(
          ({ className, labelKey, percentage, formatted }) => html`
            <div
              class="cost-segment ${className}"
              style="width: ${percentage.toFixed(1)}%"
              title="${t(labelKey)}: ${formatted}"
            ></div>
          `,
        )}
      </div>
      <div class="cost-breakdown-legend">
        ${categories.map(
          ({ className, labelKey, formatted }) => html`
            <span class="legend-item"
              ><span class="legend-dot ${className}"></span>${t(labelKey)} ${formatted}</span
            >
          `,
        )}
      </div>
      <div class="cost-breakdown-total">
        ${t("usage.breakdown.total")}:
        ${
          isTokenMode ? formatUsageTokens(totals.totalTokens) : formatAnalysisCost(totals.totalCost)
        }
      </div>
    </div>
  `;
}
