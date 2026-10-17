import { createMemo, createSignal, For, Show } from "solid-js";
import { createEmptyCostUsageTotals } from "../../../../src/infra/session-cost-usage-totals.js";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import {
  formatAnalysisCost,
  formatUsageTokens,
  formatDayLabel,
  formatFullDate,
} from "./metrics.ts";
import type { ProviderSeries } from "./provider-series.ts";
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

/**
 * Every calendar day of the range, so columns never move as a report fills in. Missing days are
 * known zero only once the report is complete; before that they are drawn as pending.
 */
function calendarDaily(
  daily: CostDailyEntry[],
  range: UsageChartRange,
): { days: CostDailyEntry[]; pending: Set<string> } {
  const start = Date.parse(range.startDate);
  const end = Date.parse(range.endDate);
  const count = (end - start) / 86_400_000 + 1;
  // Keep long historical ranges bounded instead of creating decades of empty columns.
  if (!Number.isInteger(count) || count < 1 || count > 366) {
    return { days: daily.toSorted((a, b) => a.date.localeCompare(b.date)), pending: new Set() };
  }
  const recorded = new Map(daily.map((day) => [day.date, day]));
  const pending = new Set<string>();
  const days = Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const day = recorded.get(date);
    if (!day && !range.complete) {
      pending.add(date);
    }
    return day ?? { ...createEmptyCostUsageTotals(), date };
  });
  return { days, pending };
}

type ChartSeries = { id: string; label: string; color: string; values: number[] };

/** Token types keep the colors the per-turn chart and breakdown use. */
const TOKEN_TYPE_COLORS = {
  output: "var(--accent)",
  input: "var(--ok)",
  cacheWrite: "var(--warn)",
  cacheRead: "var(--info)",
} as const;

/** One precision for every tick, fine enough to tell the half tick from zero. */
function formatAxisCost(value: number, scale: number): string {
  const digits =
    scale >= 10 ? 0 : scale > 0 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(scale / 2)))) : 2;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Rounds an axis maximum up to 1, 2 or 5 times a power of ten. */
function niceCeiling(value: number): number {
  if (value <= 0) {
    return 0;
  }
  const step = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((factor) => factor * step >= value * (1 - 1e-9)) ?? 10) * step;
}

/** Daily totals as columns stacked by total, token type or provider; a click filters days. */
export function DailyChartCompact(props: {
  dailyEntries: CostDailyEntry[];
  selectedDays: string[];
  chartMode: "tokens" | "cost";
  dailyChartMode: UsageProps["display"]["dailyChartMode"];
  onDailyChartModeChange: (mode: UsageProps["display"]["dailyChartMode"]) => void;
  providerSeries: ProviderSeries[];
  onSelectDay: UsageProps["callbacks"]["filters"]["onSelectDay"];
  range: UsageChartRange;
}) {
  const calendar = createMemo(() => calendarDaily(props.dailyEntries, props.range));
  const days = () => calendar().days;
  const dates = createMemo(() => days().map((day) => day.date));
  const isTokens = () => props.chartMode === "tokens";
  const measure = (value: number) =>
    isTokens() ? formatUsageTokens(value) : formatAnalysisCost(value);
  const axisLabel = (value: number) =>
    isTokens() ? formatUsageTokens(value) : formatAxisCost(value, scale());
  const series = createMemo((): ChartSeries[] => {
    const daily = days();
    const tokens = isTokens();
    if (props.dailyChartMode === "by-type") {
      return USAGE_TOKEN_CATEGORIES.map(({ key, labelKey }) => ({
        id: key,
        label: t(labelKey),
        color: TOKEN_TYPE_COLORS[key],
        values: daily.map((day) => (tokens ? day[key] : (day[`${key}Cost`] ?? 0))),
      }));
    }
    if (props.dailyChartMode === "by-provider") {
      const providers = props.providerSeries
        .map((provider) => ({
          id: provider.id,
          label: providerDisplayLabel(provider.id),
          color: provider.color,
          values: daily.map((day) => {
            const value = provider.byDate.get(day.date);
            return (tokens ? value?.tokens : value?.cost) ?? 0;
          }),
        }))
        .filter((entry) => entry.values.some((value) => value > 0));
      // Usage without per-model rows still counts toward the day, as "Other".
      const other = daily.map((day, index) => {
        const total = tokens ? day.totalTokens : day.totalCost;
        const rest = total - providers.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0);
        return rest > total * 0.001 ? rest : 0;
      });
      if (other.some((value) => value > 0)) {
        providers.push({
          id: "other",
          label: t("usage.daily.other"),
          color: "var(--oc-border-strong)",
          values: other,
        });
      }
      return providers;
    }
    return [
      {
        id: "total",
        label: t(tokens ? "usage.metrics.tokens" : "usage.metrics.cost"),
        color: "var(--accent)",
        values: daily.map((day) => (tokens ? day.totalTokens : day.totalCost)),
      },
    ];
  });
  const totals = createMemo(() =>
    dates().map((_, index) => series().reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0)),
  );
  const scale = createMemo(() => niceCeiling(Math.max(...totals(), 0)));
  const shares = createMemo(() => {
    const sum = totals().reduce((total, value) => total + value, 0);
    return series().map((entry) => ({
      id: entry.id,
      label: entry.label,
      color: entry.color,
      share: sum > 0 ? entry.values.reduce((total, value) => total + value, 0) / sum : 0,
    }));
  });
  const selected = createMemo(() => new Set(props.selectedDays));
  // An object, not the index alone: index 0 must still read as hovering.
  const [hover, setHover] = createSignal<{ index: number } | null>(null);
  const labelEvery = createMemo(() => Math.max(1, Math.ceil(dates().length / 7)));
  const dimmed = (index: number) => {
    const active = hover();
    return active
      ? active.index !== index
      : selected().size > 0 && !selected().has(dates()[index] ?? "");
  };
  const dayLabel = (index: number) => {
    const day = days()[index];
    if (day && calendar().pending.has(day.date)) {
      return `${formatFullDate(day.date)}: ${t("usage.daily.pending")}`;
    }
    const tokens = `${formatUsageTokens(day?.totalTokens ?? 0)} ${t("usage.metrics.tokens").toLowerCase()}`;
    return `${formatFullDate(day?.date ?? "")}: ${tokens}, ${formatAnalysisCost(day?.totalCost ?? 0)}`;
  };
  const tipPosition = (index: number) => {
    const share = (index + 0.5) / Math.max(1, dates().length);
    // Keep the readout inside the plot near either edge.
    return {
      left: `${share * 100}%`,
      transform: `translateX(${share < 0.15 ? "-10%" : share > 0.85 ? "-90%" : "-50%"})`,
    };
  };
  return (
    <div class="daily-chart-compact">
      <div class="daily-chart-header">
        <div class="card-title">
          {isTokens() ? t("usage.daily.tokensTitle") : t("usage.daily.costTitle")}
          <div class="card-sub daily-chart-range">
            {formatFullDate(props.range.startDate)} – {formatFullDate(props.range.endDate)}
          </div>
        </div>
        <SettingsSegmented
          mode="buttons"
          variant="accent"
          class="small sessions-toggle"
          value={props.dailyChartMode}
          onChange={(mode) => props.onDailyChartModeChange(mode)}
          onReselect={(mode) => props.onDailyChartModeChange(mode)}
          options={[
            { value: "total", label: t("usage.daily.total") },
            { value: "by-type", label: t("usage.daily.byType") },
            { value: "by-provider", label: t("usage.daily.byProvider") },
          ]}
        />
      </div>
      <Show
        when={dates().length > 0}
        fallback={<div class="usage-empty-block">{t("usage.empty.noData")}</div>}
      >
        <div class="daily-chart">
          <div class="daily-chart-scale" aria-hidden="true">
            <span>{axisLabel(scale())}</span>
            <span>{axisLabel(scale() / 2)}</span>
            <span>{axisLabel(0)}</span>
          </div>
          <div class="daily-chart-plot" onPointerLeave={() => setHover(null)}>
            <div class="daily-chart-bars" style={{ "--daily-columns": String(dates().length) }}>
              <For each={dates()} keyed={false}>
                {(date, index) => (
                  <button
                    type="button"
                    class={[
                      "daily-bar-wrapper",
                      {
                        selected: selected().has(date()),
                        "daily-bar-wrapper--dim": dimmed(index),
                        "daily-bar-wrapper--pending": calendar().pending.has(date()),
                      },
                    ]}
                    aria-pressed={selected().has(date()) ? "true" : "false"}
                    aria-label={dayLabel(index)}
                    onPointerEnter={() => setHover({ index })}
                    onFocus={() => setHover({ index })}
                    onBlur={() => setHover(null)}
                    onKeyDown={(event: KeyboardEvent) => {
                      // Shift+Space and Shift+Enter extend the range like Shift-click.
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        props.onSelectDay(date(), event.shiftKey, dates());
                      }
                    }}
                    onClick={(event: MouseEvent) =>
                      props.onSelectDay(date(), event.shiftKey, dates())
                    }
                  >
                    <span
                      class={["daily-bar", { "daily-bar--empty": !totals()[index] }]}
                      style={{
                        height: `${scale() > 0 ? (((totals()[index] ?? 0) / scale()) * 100).toFixed(2) : 0}%`,
                      }}
                    >
                      <For each={series().filter((entry) => (entry.values[index] ?? 0) > 0)}>
                        {(entry) => (
                          <span
                            class="cost-segment"
                            style={{
                              background: entry.color,
                              "flex-grow": String(entry.values[index] ?? 0),
                            }}
                          />
                        )}
                      </For>
                    </span>
                    <span
                      class={[
                        "daily-bar-label",
                        { "daily-bar-label--hidden": index % labelEvery() !== 0 },
                      ]}
                    >
                      {formatDayLabel(date())}
                    </span>
                  </button>
                )}
              </For>
            </div>
            <Show when={hover()}>
              {(active) => (
                <div class="daily-chart-tip" role="status" style={tipPosition(active().index)}>
                  <strong>
                    {formatFullDate(dates()[active().index] ?? "")} ·{" "}
                    {measure(totals()[active().index] ?? 0)}
                  </strong>
                  <Show when={series().length > 1}>
                    <For each={series().filter((entry) => (entry.values[active().index] ?? 0) > 0)}>
                      {(entry) => (
                        <span>
                          <i style={{ background: entry.color }} />
                          {entry.label}
                          <b>{measure(entry.values[active().index] ?? 0)}</b>
                        </span>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </div>
        <Show when={shares().length > 1}>
          <ul class="daily-chart-legend">
            <For each={shares().toSorted((a, b) => b.share - a.share)}>
              {(entry) => (
                <li>
                  <span class="daily-chart-legend__key" style={{ background: entry.color }} />
                  {entry.label}
                  <b>{`${(entry.share * 100).toFixed(entry.share < 0.1 ? 1 : 0)}%`}</b>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
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
              class={["cost-segment", className]}
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
              <span class={["legend-dot", className]} />
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
