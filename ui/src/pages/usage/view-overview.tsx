import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { For, Show, createMemo } from "solid-js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { providerDisplayLabel } from "../../components/provider-icon.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import { formatIsoDate } from "./helpers.ts";
import {
  buildUsageCostWindows,
  formatAnalysisCost,
  formatDayLabel,
  formatFullDate,
  formatUsageTokens,
} from "./metrics.ts";
import type { UsageInsightStats } from "./metrics.ts";
import type {
  UsageAggregates,
  UsageProps,
  UsageSessionEntry,
  UsageTotals,
  CostDailyEntry,
} from "./types.ts";
import { SummaryStat } from "./view-summary-stat.tsx";

function renderFilterChips(
  sessions: UsageSessionEntry[],
  { filters, callbacks }: Pick<UsageProps, "filters" | "callbacks">,
) {
  const { selectedDays, selectedHours, selectedSessions } = filters;
  const { onClearDays, onClearHours, onClearSessions, onClearFilters } = callbacks.filters;
  const hasFilters =
    selectedDays.length > 0 || selectedHours.length > 0 || selectedSessions.length > 0;
  if (!hasFilters) {
    return undefined;
  }

  const selectedSessionKey = selectedSessions.at(0) ?? "";
  const selectedSession =
    selectedSessions.length === 1 ? sessions.find((s) => s.key === selectedSessionKey) : null;
  const sessionsLabel = selectedSession
    ? truncateUtf16Safe(selectedSession.label || selectedSession.key, 20) +
      ((selectedSession.label || selectedSession.key).length > 20 ? "…" : "")
    : selectedSessions.length === 1
      ? truncateUtf16Safe(selectedSessionKey, 8) + "…"
      : t("usage.filters.sessionsCount", { count: String(selectedSessions.length) });
  const sessionsFullName = selectedSession
    ? selectedSession.label || selectedSession.key
    : selectedSessions.length === 1
      ? selectedSessionKey
      : selectedSessions.join(", ");

  const daysLabel =
    selectedDays.length === 1
      ? selectedDays[0]
      : t("usage.filters.daysCount", { count: String(selectedDays.length) });
  const hoursLabel =
    selectedHours.length === 1
      ? `${selectedHours[0]}:00`
      : t("usage.filters.hoursCount", { count: String(selectedHours.length) });
  const chips = [
    {
      active: selectedDays.length > 0,
      labelKey: "usage.filters.days",
      value: daysLabel,
      removeKey: "usage.filters.removeDays",
      onClear: onClearDays,
    },
    {
      active: selectedHours.length > 0,
      labelKey: "usage.filters.hours",
      value: hoursLabel,
      removeKey: "usage.filters.removeHours",
      onClear: onClearHours,
    },
    {
      active: selectedSessions.length > 0,
      labelKey: "usage.filters.session",
      value: sessionsLabel,
      removeKey: "usage.filters.removeSession",
      onClear: onClearSessions,
      title: sessionsFullName,
    },
  ];

  return (
    <div class="active-filters">
      <For each={chips.filter(({ active }) => active)}>
        {({ labelKey, value, removeKey, onClear, title }) => (
          <div class="filter-chip" title={title}>
            <span class="filter-chip-label">
              {t(labelKey)}: {value}
            </span>
            <openclaw-tooltip prop:content={t("usage.filters.remove")}>
              <button class="filter-chip-remove" onClick={onClear} aria-label={t(removeKey)}>
                <Icon name="x" />
              </button>
            </openclaw-tooltip>
          </div>
        )}
      </For>
      {(selectedDays.length > 0 || selectedHours.length > 0) && selectedSessions.length > 0 ? (
        <button class="btn btn--sm" onClick={onClearFilters}>
          {t("usage.filters.clearAll")}
        </button>
      ) : undefined}
    </div>
  );
}

/** Daily cost per calendar day of a window, zero-filled; null for ranges too long to draw as columns. */
function windowDailyCosts(costs: Map<string, number>, endDate: string, days: number) {
  if (days < 2 || days > 92) {
    return null;
  }
  const start = Date.parse(endDate) - (days - 1) * 86_400_000;
  return Array.from(
    { length: days },
    (_, index) => costs.get(new Date(start + index * 86_400_000).toISOString().slice(0, 10)) ?? 0,
  );
}

/** Carapace mini columns: quiet bars, the newest period in accent. */
function CostColumns(props: { values: number[]; label: string }) {
  const max = () => Math.max(...props.values, 0);
  return (
    <svg
      class="usage-bars"
      viewBox={`0 0 ${props.values.length * 10} 28`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <For each={props.values}>
        {(value, index) => {
          const height = () => (max() > 0 && value > 0 ? Math.max(1.5, (value / max()) * 26) : 0);
          return (
            <rect
              class={[
                "usage-bars__bar",
                { "usage-bars__bar--current": index() === props.values.length - 1 },
              ]}
              x={index() * 10 + 1}
              y={28 - height()}
              width={8}
              height={height()}
            />
          );
        }}
      </For>
    </svg>
  );
}

function renderCostWindowComparison(
  daily: CostDailyEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
  timeZone: "local" | "utc",
) {
  const windows = buildUsageCostWindows(daily, rangeStartDate, rangeEndDate);
  if (windows.length === 0 || daily.length === 0) {
    return undefined;
  }

  const today = formatIsoDate(new Date(), timeZone);
  const costs = new Map(daily.map((day) => [day.date, day.totalCost]));

  return (
    <SettingsSection
      title={t("usage.costWindows.title")}
      description={t("usage.costWindows.subtitle", { date: formatFullDate(rangeEndDate) })}
      actions={
        <span class="usage-section-meta cost-window-range">
          {formatDayLabel(rangeStartDate)} – {formatDayLabel(rangeEndDate)}
        </span>
      }
    >
      <div class="usage-summary-strip usage-summary-strip--windows">
        <For each={Array.from(windows.entries())}>
          {([index, summary]) => {
            const label =
              index === 0
                ? t("usage.costWindows.selectedRange")
                : summary.days === 1
                  ? summary.endDate === today
                    ? t("usage.presets.today")
                    : formatDayLabel(summary.endDate)
                  : t("usage.costWindows.lastDays", { count: String(summary.days) });
            const columns = windowDailyCosts(costs, summary.endDate, summary.days);
            return (
              <div class={["cost-window", { "cost-window--range": index === 0 }]}>
                <div class="cost-window__label">{label}</div>
                <div class="cost-window__value">{formatAnalysisCost(summary.totals.totalCost)}</div>
                <div class="cost-window__meta">
                  {formatUsageTokens(summary.totals.totalTokens)}{" "}
                  {normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
                  {summary.days > 1
                    ? ` · ${formatAnalysisCost(summary.totals.totalCost / summary.days)} ${t("usage.costWindows.perDay")}`
                    : undefined}
                </div>
                {columns ? <CostColumns values={columns} label={label} /> : undefined}
              </div>
            );
          }}
        </For>
      </div>
    </SettingsSection>
  );
}

function renderInsightList(
  title: string,
  items: Array<{ label: string; value: string; sub?: string; agentId?: string }>,
  emptyLabel: string,
  options?: {
    className?: string;
    listClassName?: string;
    error?: boolean;
  },
) {
  return (
    <div class={["usage-insight-card", options?.className]}>
      <div class="usage-insight-title">{title}</div>
      {items.length === 0 ? (
        <div class="muted">{emptyLabel}</div>
      ) : (
        <div class={[options?.error ? "usage-error-list" : "usage-list", options?.listClassName]}>
          <For each={items}>
            {(item) =>
              options?.error ? (
                <div class="usage-error-row">
                  <div class="usage-error-date">{item.label}</div>
                  <div class="usage-error-rate">{item.value}</div>
                  {item.sub ? <div class="usage-error-sub">{item.sub}</div> : undefined}
                </div>
              ) : (
                <div class="usage-list-item">
                  <span class="usage-list-label" title={item.label}>
                    {item.agentId ? <AgentRowChip agentId={item.agentId} /> : item.label}
                  </span>
                  <span class="usage-list-value">{item.value}</span>
                  {item.sub ? <span class="usage-list-sub">{item.sub}</span> : undefined}
                </div>
              )
            }
          </For>
        </div>
      )}
    </div>
  );
}

export function UsageInsights(props: {
  totals: UsageTotals | null;
  aggregates: UsageAggregates;
  stats: UsageInsightStats;
  showCostHint: boolean;
  showCostShares: boolean;
  errorHours: Array<{ label: string; value: string; sub?: string }>;
  sessionCount: number;
  totalSessions: number;
}) {
  const state = createMemo(() => {
    const totals = props.totals;
    const aggregates = props.aggregates;
    const stats = props.stats;
    const showCostShares = props.showCostShares;
    if (!totals) {
      return undefined;
    }

    const avgTokens = aggregates.messages.total
      ? Math.round(totals.totalTokens / aggregates.messages.total)
      : 0;
    const avgCost = aggregates.messages.total ? totals.totalCost / aggregates.messages.total : 0;
    const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite;
    const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;
    const cacheHitLabel =
      cacheBase > 0 ? `${(cacheHitRate * 100).toFixed(1)}%` : t("usage.common.emptyValue");
    const errorRatePct = stats.errorRate * 100;
    const throughputLabel =
      stats.throughputTokensPerMin !== undefined
        ? `${formatUsageTokens(Math.round(stats.throughputTokensPerMin))} ${t("usage.overview.tokensPerMinute")}`
        : t("usage.common.emptyValue");
    const throughputCostLabel =
      stats.throughputCostPerMin !== undefined
        ? `${formatAnalysisCost(stats.throughputCostPerMin)} ${t("usage.overview.perMinute")}`
        : t("usage.common.emptyValue");
    const avgDurationLabel =
      stats.durationCount > 0
        ? (formatDurationCompact(stats.avgDurationMs) ?? t("usage.common.emptyValue"))
        : t("usage.common.emptyValue");
    const errorDays = aggregates.daily
      .filter((day) => day.messages > 0 && day.errors > 0)
      .toSorted((a, b) => b.errors / b.messages - a.errors / a.messages)
      .slice(0, 5)
      .map((day) => ({
        label: formatDayLabel(day.date),
        value: `${((day.errors / day.messages) * 100).toFixed(2)}%`,
        sub: `${day.errors.toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${day.messages.toLocaleString()} ${t("usage.overview.messagesAbbrev")} · ${formatUsageTokens(day.tokens, day.usageReport)}`,
      }));

    const costAttribution = (
      label: string,
      { totals: entryTotals, count }: { totals: UsageTotals; count?: number },
      agent = false,
    ) => ({
      label,
      ...(agent ? { agentId: label } : {}),
      // Usage with no known price is unpriced, never free.
      value:
        entryTotals.totalCost === 0 && entryTotals.missingCostEntries > 0
          ? t("usage.overview.unpriced")
          : formatAnalysisCost(entryTotals.totalCost, entryTotals.usageReport),
      sub: [
        showCostShares &&
        entryTotals.usageReport?.state !== "unavailable" &&
        entryTotals.totalCost > 0 &&
        totals.totalCost > 0
          ? t("usage.overview.costShare", {
              percent: ((entryTotals.totalCost / totals.totalCost) * 100).toFixed(1),
            })
          : null,
        formatUsageTokens(entryTotals.totalTokens, entryTotals.usageReport),
        count === undefined
          ? null
          : `${count.toLocaleString()} ${t("usage.overview.messagesAbbrev")}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    });

    const topModels = aggregates.byModel
      .slice(0, 5)
      .map((entry) => costAttribution(entry.model ?? t("usage.common.unknown"), entry));
    // Aliases such as claude-cli fold into the provider they bill through.
    const providerTotals = Map.groupBy(
      aggregates.byProvider,
      (entry) => canonicalModelAuthProviderId(entry.provider ?? "") || entry.provider || "",
    );
    const topProviders = [...providerTotals]
      .map(([id, entries]) => {
        const merged = createEmptyCostUsageTotals();
        for (const entry of entries) {
          addCostUsageTotals(merged, entry.totals);
        }
        return {
          id,
          totals: merged,
          count: entries.reduce((sum, entry) => sum + entry.count, 0),
        };
      })
      .toSorted(
        (a, b) =>
          b.totals.totalCost - a.totals.totalCost || b.totals.totalTokens - a.totals.totalTokens,
      )
      .slice(0, 5)
      .map((entry) =>
        costAttribution(
          entry.id ? providerDisplayLabel(entry.id) : t("usage.common.unknown"),
          entry,
        ),
      );
    const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
      label: tool.name,
      value: `${tool.count.toLocaleString()} ${t("usage.overview.calls")}`,
    }));
    const topAgents = aggregates.byAgent
      .slice(0, 5)
      .map((entry) => costAttribution(entry.agentId, entry, true));
    const topChannels = aggregates.byChannel
      .slice(0, 5)
      .map((entry) => costAttribution(entry.channel, entry));
    const insightLists = [
      ["usage.overview.topModels", topModels, "usage.overview.noModelData"],
      ["usage.overview.topProviders", topProviders, "usage.overview.noProviderData"],
      ["usage.overview.topTools", topTools, "usage.overview.noToolCalls"],
      ["usage.overview.topAgents", topAgents, "usage.overview.noAgentData"],
      ["usage.overview.topChannels", topChannels, "usage.overview.noChannelData"],
    ] as const;

    return {
      aggregates,
      throughputLabel,
      throughputCostLabel,
      avgTokens,
      cacheHitLabel,
      totals,
      cacheBase,
      cacheHitRate,
      errorRatePct,
      avgDurationLabel,
      avgCost,
      insightLists,
      errorDays,
    };
  });
  return (
    <Show when={state()}>
      {(insights) => (
        <SettingsSection title={t("usage.overview.title")}>
          <section class="usage-panel usage-overview-card">
            <div class="usage-overview-layout">
              <div class="usage-summary-grid">
                <SummaryStat
                  hintId="messages"
                  metric="messages"
                  value={insights().aggregates.messages.total}
                  sub={`${insights().aggregates.messages.user.toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} · ${insights().aggregates.messages.assistant.toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`}
                />
                <SummaryStat
                  hintId="throughput"
                  metric="throughput"
                  value={insights().throughputLabel}
                  sub={insights().throughputCostLabel}
                  compactValue
                />
                <SummaryStat
                  hintId="tool-calls"
                  metric="toolCalls"
                  value={insights().aggregates.tools.totalCalls}
                  sub={`${insights().aggregates.tools.uniqueTools} ${t("usage.overview.toolsUsed")}`}
                />
                <SummaryStat
                  hintId="average-tokens"
                  metric="avgTokens"
                  value={formatUsageTokens(insights().avgTokens)}
                  sub={t("usage.overview.acrossMessages", {
                    count: (insights().aggregates.messages.total || 0).toLocaleString(),
                  })}
                />
                <SummaryStat
                  hintId="cache-hit-rate"
                  metric="cacheHitRate"
                  hint={t("usage.overview.cacheHint")}
                  value={insights().cacheHitLabel}
                  sub={`${formatUsageTokens(insights().totals.cacheRead)} ${t("usage.overview.cached")} · ${formatUsageTokens(insights().cacheBase)} ${t("usage.overview.prompt")}`}
                  tone={
                    insights().cacheHitRate > 0.6
                      ? "good"
                      : insights().cacheHitRate > 0.3
                        ? "warn"
                        : "bad"
                  }
                />
                <SummaryStat
                  hintId="error-rate"
                  metric="errorRate"
                  hint={t("usage.overview.errorHint")}
                  value={`${insights().errorRatePct.toFixed(2)}%`}
                  sub={`${insights().aggregates.messages.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${insights().avgDurationLabel} ${t("usage.overview.avgSession")}`}
                  tone={
                    insights().errorRatePct > 5
                      ? "bad"
                      : insights().errorRatePct > 1
                        ? "warn"
                        : "good"
                  }
                />
                <SummaryStat
                  hintId="average-cost"
                  metric="avgCost"
                  hint={t(
                    props.showCostHint
                      ? "usage.overview.avgCostHintMissing"
                      : "usage.overview.avgCostHint",
                  )}
                  value={formatAnalysisCost(insights().avgCost)}
                  sub={`${formatAnalysisCost(insights().totals.totalCost)} ${normalizeLowercaseStringOrEmpty(t("usage.breakdown.total"))}`}
                />
                <SummaryStat
                  hintId="sessions"
                  metric="sessions"
                  value={props.sessionCount}
                  sub={t("usage.overview.sessionsInRange", {
                    count: props.totalSessions.toLocaleString(),
                  })}
                />
                <SummaryStat
                  hintId="errors"
                  metric="errors"
                  value={insights().aggregates.messages.errors}
                  sub={`${insights().aggregates.messages.toolResults.toLocaleString()} ${t("usage.overview.toolResults")}`}
                />
              </div>
              <div class="usage-insights-grid">
                <For each={insights().insightLists}>
                  {([titleKey, items, emptyKey]) => (
                    <>{renderInsightList(t(titleKey), items, t(emptyKey))}</>
                  )}
                </For>
                {renderInsightList(
                  t("usage.overview.peakErrorDays"),
                  insights().errorDays,
                  t("usage.overview.noErrorData"),
                  { error: true },
                )}
                {renderInsightList(
                  t("usage.overview.peakErrorHours"),
                  props.errorHours,
                  t("usage.overview.noErrorData"),
                  { error: true, listClassName: "usage-error-list--hours" },
                )}
              </div>
            </div>
          </section>
        </SettingsSection>
      )}
    </Show>
  );
}

export { renderCostWindowComparison, renderFilterChips, renderInsightList };
