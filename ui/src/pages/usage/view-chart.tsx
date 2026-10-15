import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo, For, Show } from "solid-js";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
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

export function DailyChartCompact(props: {
  dailyEntries: CostDailyEntry[];
  selectedDays: string[];
  chartMode: "tokens" | "cost";
  dailyChartMode: "total" | "by-type";
  onDailyChartModeChange: (mode: "total" | "by-type") => void;
  onSelectDay: UsageProps["callbacks"]["filters"]["onSelectDay"];
  range: UsageChartRange;
}) {
  const state = createMemo(() => {
    const dailyEntries = props.dailyEntries;
    const selectedDays = props.selectedDays;
    const chartMode = props.chartMode;
    const dailyChartMode = props.dailyChartMode;
    const onDailyChartModeChange = props.onDailyChartModeChange;
    const onSelectDay = props.onSelectDay;
    const range = props.range;
    const daily = calendarDaily(dailyEntries, range);
    const orderedDays = daily.map((entry) => entry.date);
    const isTokenMode = chartMode === "tokens";
    const stacked = dailyChartMode === "by-type";
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
    const barMaxWidth =
      daily.length > 30 ? 12 : daily.length > 20 ? 18 : daily.length > 14 ? 24 : 32;
    const showTotals = daily.length <= 14;
    const selectedDaySet = new Set(selectedDays);

    const bars = daily.map((d, idx) => {
      const total = isTokenMode ? d.totalTokens : d.totalCost;
      const ratio = usesCompressedScale ? Math.sqrt(total / maxValue) : total / maxValue;
      const heightPx = total <= 0 ? 0 : Math.max(minBarPx, ratio * chartAreaPx);
      const isSelected = selectedDaySet.has(d.date);
      const showDateLabel =
        daily.length <= 14 || idx % Math.ceil(daily.length / 6) === 0 || idx === daily.length - 1;
      const labelClass = showDateLabel
        ? "daily-bar-label"
        : "daily-bar-label daily-bar-label--hidden";
      const segments = stacked
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
      const tokensLabel = `${formatUsageTokens(d.totalTokens)} ${normalizeLowercaseStringOrEmpty(
        t("usage.metrics.tokens"),
      )}`.trim();
      const costLabel = formatAnalysisCost(d.totalCost);
      const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
      return {
        date: d.date,
        tooltip: [dateLabel, tokensLabel, costLabel, ...breakdownLines].join("\n"),
        isSelected,
        ariaLabel: `${dateLabel}: ${tokensLabel}, ${costLabel}`,
        heightPx,
        segments,
        segmentTotal,
        totalLabel,
        labelClass,
      };
    });

    return {
      daily,
      dailyChartMode,
      onDailyChartModeChange,
      isTokenMode,
      range,
      usesCompressedScale,
      scaleMaximum,
      barMaxWidth,
      bars,
      onSelectDay,
      orderedDays,
      stacked,
      showTotals,
    };
  });
  return (
    <Show
      when={state().daily.length > 0}
      fallback={
        <div class="daily-chart-compact">
          <div class="card-title usage-section-title">{t("usage.daily.title")}</div>
          <div class="usage-empty-block">{t("usage.empty.noData")}</div>
        </div>
      }
    >
      <div class="daily-chart-compact">
        <div class="daily-chart-header">
          <SettingsSegmented
            mode="buttons"
            variant="accent"
            class="small sessions-toggle"
            value={state().dailyChartMode}
            onChange={state().onDailyChartModeChange}
            onReselect={state().onDailyChartModeChange}
            options={[
              { value: "total", label: t("usage.daily.total") },
              { value: "by-type", label: t("usage.daily.byType") },
            ]}
          />
          <div class="card-title">
            {state().isTokenMode ? t("usage.daily.tokensTitle") : t("usage.daily.costTitle")}
            <div class="card-sub daily-chart-range">
              {formatFullDate(state().range.startDate)} – {formatFullDate(state().range.endDate)}
            </div>
            {state().usesCompressedScale ? (
              <>
                {" "}
                <span
                  class="daily-chart-scale-badge"
                  title={t("usage.daily.compressedScaleHint")}
                  aria-label={t("usage.daily.compressedScaleHint")}
                >
                  √
                </span>{" "}
              </>
            ) : undefined}
          </div>
        </div>
        <div class="daily-chart">
          <div class="daily-chart-plot">
            <div class="daily-chart-scale" aria-hidden="true">
              <For
                each={
                  state().scaleMaximum > 0
                    ? [
                        state().scaleMaximum,
                        state().scaleMaximum / (state().usesCompressedScale ? 4 : 2),
                        0,
                      ]
                    : [0]
                }
              >
                {(value) => (
                  <>
                    {" "}
                    <span>
                      {state().isTokenMode
                        ? formatUsageTokens(value)
                        : value === 0
                          ? formatUsageCost(0)
                          : formatAnalysisCost(value)}
                    </span>{" "}
                  </>
                )}
              </For>
            </div>
            <div class="daily-chart-bars" style={{ "--bar-max-width": `${state().barMaxWidth}px` }}>
              <For each={state().bars} keyed={(bar) => bar.date}>
                {(bar) => (
                  <openclaw-tooltip prop:content={bar().tooltip}>
                    <div
                      class={["daily-bar-wrapper", { selected: bar().isSelected }]}
                      role="button"
                      tabindex="0"
                      aria-pressed={bar().isSelected ? "true" : "false"}
                      aria-label={bar().ariaLabel}
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          state().onSelectDay(bar().date, event.shiftKey, state().orderedDays);
                        }
                      }}
                      onClick={(event: MouseEvent) =>
                        state().onSelectDay(bar().date, event.shiftKey, state().orderedDays)
                      }
                    >
                      <Show when={state().dailyChartMode} keyed>
                        {(_mode) => (
                          <div
                            class={[
                              "daily-bar",
                              {
                                "daily-bar--stacked": state().stacked,
                                "daily-bar--empty": bar().heightPx === 0,
                              },
                            ]}
                            style={{ height: `${bar().heightPx.toFixed(0)}px` }}
                          >
                            <For each={bar().segments}>
                              {({ className, value }) => (
                                <div
                                  class={`cost-segment ${className}`}
                                  style={{ height: `${(value / bar().segmentTotal) * 100}%` }}
                                />
                              )}
                            </For>
                          </div>
                        )}
                      </Show>
                      {state().showTotals ? (
                        <div class="daily-bar-total">{bar().totalLabel}</div>
                      ) : (
                        <div
                          class="daily-bar-total daily-bar-total--placeholder"
                          aria-hidden="true"
                        />
                      )}
                      <div class={bar().labelClass}>{formatDayLabel(bar().date)}</div>
                    </div>
                  </openclaw-tooltip>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

export function CostBreakdownCompact(props: { totals: UsageTotals; mode: "tokens" | "cost" }) {
  const state = createMemo(() => {
    const totals = props.totals;
    const mode = props.mode;
    const isTokenMode = mode === "tokens";
    const total = isTokenMode ? totals.totalTokens || 1 : totals.totalCost || 0;
    const categories = USAGE_TOKEN_CATEGORIES.map(({ key, className, labelKey }) => {
      const value = isTokenMode ? totals[key] : totals[`${key}Cost`] || 0;
      return {
        className,
        labelKey,
        percentage: total === 0 ? 0 : (value / total) * 100,
        formatted: isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value),
      };
    });

    return { isTokenMode, categories, totals };
  });
  return (
    <div class="cost-breakdown cost-breakdown-compact">
      <div class="cost-breakdown-header">
        {state().isTokenMode ? t("usage.breakdown.tokensByType") : t("usage.breakdown.costByType")}
      </div>
      <div class="cost-breakdown-bar">
        <For each={state().categories}>
          {({ className, labelKey, percentage, formatted }) => (
            <div
              class={`cost-segment ${className}`}
              style={{ width: `${percentage.toFixed(1)}%` }}
              title={`${t(labelKey)}: ${formatted}`}
            />
          )}
        </For>
      </div>
      <div class="cost-breakdown-legend">
        <For each={state().categories}>
          {({ className, labelKey, formatted }) => (
            <span class="legend-item">
              <span class={`legend-dot ${className}`} />
              {t(labelKey)} {formatted}
            </span>
          )}
        </For>
      </div>
      <div class="cost-breakdown-total">
        {t("usage.breakdown.total")}:{" "}
        {state().isTokenMode
          ? formatUsageTokens(state().totals.totalTokens)
          : formatAnalysisCost(state().totals.totalCost)}
      </div>
    </div>
  );
}
