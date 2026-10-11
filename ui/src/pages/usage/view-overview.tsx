import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import "../../components/agent-row-chip.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
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
import { renderSummaryStat } from "./view-summary-stat.tsx";

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

  return (
    <section class="cost-window-analysis">
      <div class="cost-window-header">
        <div>
          <div class="card-title usage-section-title">{t("usage.costWindows.title")}</div>
          <div class="card-sub">
            {t("usage.costWindows.subtitle", { date: formatFullDate(rangeEndDate) })}
          </div>
        </div>
        <div class="cost-window-range-label">
          {formatDayLabel(rangeStartDate)} – {formatDayLabel(rangeEndDate)}
        </div>
      </div>
      <div class="cost-window-grid">
        <For each={Array.from(windows.entries())}>
          {([index, summary]) => {
            const isRange = index === 0;
            const label = () =>
              isRange
                ? t("usage.costWindows.selectedRange")
                : summary.days === 1
                  ? summary.endDate === today
                    ? t("usage.presets.today")
                    : formatDayLabel(summary.endDate)
                  : t("usage.costWindows.lastDays", { count: String(summary.days) });
            const averageDailyCost = summary.totals.totalCost / summary.days;
            return (
              <div class={["cost-window-card", { "cost-window-card--range": isRange }]}>
                <div class="cost-window-card__label">{label()}</div>
                <div class="cost-window-card__value">
                  {formatAnalysisCost(summary.totals.totalCost)}
                </div>
                <div class="cost-window-card__meta">
                  {`${formatUsageTokens(summary.totals.totalTokens)} ${t("usage.metrics.tokens")} · ${formatAnalysisCost(averageDailyCost)} ${t("usage.costWindows.perDay")}`}
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </section>
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
  const cardClass = ["usage-insight-card", options?.className].filter(Boolean).join(" ");
  const listClass = [options?.error ? "usage-error-list" : "usage-list", options?.listClassName]
    .filter(Boolean)
    .join(" ");
  return (
    <div class={cardClass}>
      <div class="usage-insight-title">{title}</div>
      {items.length === 0 ? (
        <div class="muted">{emptyLabel}</div>
      ) : (
        <div class={listClass}>
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
                  <span>
                    {item.agentId ? (
                      <openclaw-agent-row-chip prop:agentId={item.agentId} />
                    ) : (
                      item.label
                    )}
                  </span>
                  <span class="usage-list-value">
                    <span>{item.value}</span>
                    {item.sub ? (
                      <>
                        {" "}
                        <span class="usage-list-sub">{item.sub}</span>{" "}
                      </>
                    ) : undefined}
                  </span>
                </div>
              )
            }
          </For>
        </div>
      )}
    </div>
  );
}

function renderUsageInsights(
  totals: UsageTotals | null,
  aggregates: UsageAggregates,
  stats: UsageInsightStats,
  showCostHint: boolean,
  showCostShares: boolean,
  errorHours: Array<{ label: string; value: string; sub?: string }>,
  sessionCount: number,
  totalSessions: number,
) {
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
      sub: `${day.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${day.messages} ${t("usage.overview.messagesAbbrev")} · ${formatUsageTokens(day.tokens)}`,
    }));

  const costAttribution = (
    label: string,
    { totals: entryTotals, count }: { totals: UsageTotals; count?: number },
    agent = false,
  ) => ({
    label,
    ...(agent ? { agentId: label } : {}),
    value: formatAnalysisCost(entryTotals.totalCost),
    sub: [
      showCostShares && totals.totalCost > 0
        ? t("usage.overview.costShare", {
            percent: ((entryTotals.totalCost / totals.totalCost) * 100).toFixed(1),
          })
        : null,
      formatUsageTokens(entryTotals.totalTokens),
      count === undefined ? null : `${count} ${t("usage.overview.messagesAbbrev")}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  });

  const topModels = aggregates.byModel
    .slice(0, 5)
    .map((entry) => costAttribution(entry.model ?? t("usage.common.unknown"), entry));
  const topProviders = aggregates.byProvider
    .slice(0, 5)
    .map((entry) => costAttribution(entry.provider ?? t("usage.common.unknown"), entry));
  const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
    label: tool.name,
    value: `${tool.count}`,
    sub: t("usage.overview.calls"),
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

  return (
    <SettingsSection title={t("usage.overview.title")}>
      <section class="usage-panel usage-overview-card">
        <div class="usage-overview-layout">
          <div class="usage-summary-grid">
            {renderSummaryStat({
              hintId: "messages",
              metric: "messages",
              value: aggregates.messages.total,
              sub: `${aggregates.messages.user} ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} · ${aggregates.messages.assistant} ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`,
              className: "usage-summary-card--hero",
            })}
            {renderSummaryStat({
              hintId: "throughput",
              metric: "throughput",
              value: throughputLabel,
              sub: throughputCostLabel,
              className: "usage-summary-card--hero usage-summary-card--throughput",
              compactValue: true,
            })}
            {renderSummaryStat({
              hintId: "tool-calls",
              metric: "toolCalls",
              value: aggregates.tools.totalCalls,
              sub: `${aggregates.tools.uniqueTools} ${t("usage.overview.toolsUsed")}`,
              className: "usage-summary-card--half",
            })}
            {renderSummaryStat({
              hintId: "average-tokens",
              metric: "avgTokens",
              value: formatUsageTokens(avgTokens),
              sub: t("usage.overview.acrossMessages", {
                count: String(aggregates.messages.total || 0),
              }),
              className: "usage-summary-card--half",
            })}
            {renderSummaryStat({
              hintId: "cache-hit-rate",
              metric: "cacheHitRate",
              hint: t("usage.overview.cacheHint"),
              value: cacheHitLabel,
              sub: `${formatUsageTokens(totals.cacheRead)} ${t("usage.overview.cached")} · ${formatUsageTokens(cacheBase)} ${t("usage.overview.prompt")}`,
              tone: cacheHitRate > 0.6 ? "good" : cacheHitRate > 0.3 ? "warn" : "bad",
              className: "usage-summary-card--medium",
            })}
            {renderSummaryStat({
              hintId: "error-rate",
              metric: "errorRate",
              hint: t("usage.overview.errorHint"),
              value: `${errorRatePct.toFixed(2)}%`,
              sub: `${aggregates.messages.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${avgDurationLabel} ${t("usage.overview.avgSession")}`,
              tone: errorRatePct > 5 ? "bad" : errorRatePct > 1 ? "warn" : "good",
              className: "usage-summary-card--medium",
            })}
            {renderSummaryStat({
              hintId: "average-cost",
              metric: "avgCost",
              hint: t(
                showCostHint ? "usage.overview.avgCostHintMissing" : "usage.overview.avgCostHint",
              ),
              value: formatAnalysisCost(avgCost),
              sub: `${formatAnalysisCost(totals.totalCost)} ${normalizeLowercaseStringOrEmpty(t("usage.breakdown.total"))}`,
              className: "usage-summary-card--compact",
            })}
            {renderSummaryStat({
              hintId: "sessions",
              metric: "sessions",
              value: sessionCount,
              sub: t("usage.overview.sessionsInRange", { count: String(totalSessions) }),
              className: "usage-summary-card--compact",
            })}
            {renderSummaryStat({
              hintId: "errors",
              metric: "errors",
              value: aggregates.messages.errors,
              sub: `${aggregates.messages.toolResults} ${t("usage.overview.toolResults")}`,
              className: "usage-summary-card--compact",
            })}
          </div>
          <div class="usage-insights-grid">
            <For each={insightLists}>
              {([titleKey, items, emptyKey]) => (
                <>{renderInsightList(t(titleKey), items, t(emptyKey))}</>
              )}
            </For>
            {renderInsightList(
              t("usage.overview.peakErrorDays"),
              errorDays,
              t("usage.overview.noErrorData"),
              { error: true },
            )}
            {renderInsightList(
              t("usage.overview.peakErrorHours"),
              errorHours,
              t("usage.overview.noErrorData"),
              {
                error: true,
                className: "usage-insight-card--wide",
                listClassName: "usage-error-list--hours",
              },
            )}
          </div>
        </div>
      </section>
    </SettingsSection>
  );
}

export { renderCostWindowComparison, renderFilterChips, renderInsightList, renderUsageInsights };
