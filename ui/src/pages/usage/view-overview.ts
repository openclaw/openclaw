import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Control UI view renders usage render overview screen content.
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { renderAgentRowChip } from "../../components/agent-row-chip.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import { renderSettingsSection, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import {
  buildUsageCostWindows,
  buildUsageCostWindowSummary,
  formatUsageCost,
  formatDayLabel,
  formatFullDate,
  formatIsoDate,
  formatUsageTokens,
} from "./metrics.ts";
import type { UsageInsightStats } from "./metrics.ts";
import type {
  UsageAggregates,
  UsageColumnId,
  UsageSessionEntry,
  UsageTotals,
  CostDailyEntry,
} from "./types.ts";

function formatAnalysisCost(value: number): string {
  const magnitude = Math.abs(value);
  const decimals = magnitude === 0 || magnitude >= 0.01 ? 2 : magnitude >= 0.0001 ? 4 : 6;
  return formatUsageCost(value, decimals);
}

function renderFilterChips(
  selectedDays: string[],
  selectedHours: number[],
  selectedSessions: string[],
  sessions: UsageSessionEntry[],
  onClearDays: () => void,
  onClearHours: () => void,
  onClearSessions: () => void,
  onClearFilters: () => void,
) {
  const hasFilters =
    selectedDays.length > 0 || selectedHours.length > 0 || selectedSessions.length > 0;
  if (!hasFilters) {
    return nothing;
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

  return html`
    <div class="active-filters">
      ${chips
        .filter(({ active }) => active)
        .map(
          ({ labelKey, value, removeKey, onClear, title }) => html`
            <div class="filter-chip" title=${ifDefined(title)}>
              <span class="filter-chip-label">${t(labelKey)}: ${value}</span>
              <openclaw-tooltip .content=${t("usage.filters.remove")}>
                <button class="filter-chip-remove" @click=${onClear} aria-label=${t(removeKey)}>
                  ×
                </button>
              </openclaw-tooltip>
            </div>
          `,
        )}
      ${
        (selectedDays.length > 0 || selectedHours.length > 0) && selectedSessions.length > 0
          ? html`
              <button class="btn btn--sm" @click=${onClearFilters}>
                ${t("usage.filters.clearAll")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

function renderCostWindowComparison(
  daily: CostDailyEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
  timeZone: "local" | "utc",
) {
  const range = buildUsageCostWindowSummary(daily, rangeStartDate, rangeEndDate);
  if (!range || daily.length === 0) {
    return nothing;
  }

  const windows = buildUsageCostWindows(daily, rangeStartDate, rangeEndDate);
  const today = formatIsoDate(new Date(), timeZone);
  const labelForWindow = (days: number, endDate: string) => {
    if (days === 1) {
      return endDate === today ? t("usage.presets.today") : formatDayLabel(endDate);
    }
    return t("usage.costWindows.lastDays", { count: String(days) });
  };
  const cards = [
    { label: t("usage.costWindows.selectedRange"), summary: range, range: true },
    ...windows.map((summary) => ({
      label: labelForWindow(summary.days, summary.endDate),
      summary,
      range: false,
    })),
  ];

  return html`
    <section class="cost-window-analysis">
      <div class="cost-window-header">
        <div>
          <div class="card-title usage-section-title">${t("usage.costWindows.title")}</div>
          <div class="card-sub">
            ${t("usage.costWindows.subtitle", { date: formatFullDate(rangeEndDate) })}
          </div>
        </div>
        <div class="cost-window-range-label">
          ${formatDayLabel(rangeStartDate)} – ${formatDayLabel(rangeEndDate)}
        </div>
      </div>
      <div class="cost-window-grid">
        ${cards.map(({ label, summary, range: isRange }) => {
          const averageDailyCost = summary.totals.totalCost / summary.days;
          return html`
            <div class="cost-window-card ${isRange ? "cost-window-card--range" : ""}">
              <div class="cost-window-card__label">${label}</div>
              <div class="cost-window-card__value">
                ${formatAnalysisCost(summary.totals.totalCost)}
              </div>
              <div class="cost-window-card__meta">
                ${formatUsageTokens(summary.totals.totalTokens)} ${t("usage.metrics.tokens")} ·
                ${formatAnalysisCost(averageDailyCost)} ${t("usage.costWindows.perDay")}
              </div>
            </div>
          `;
        })}
      </div>
    </section>
  `;
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
  return html`
    <div class=${cardClass}>
      <div class="usage-insight-title">${title}</div>
      ${
        items.length === 0
          ? html`<div class="muted">${emptyLabel}</div>`
          : html`
              <div class=${listClass}>
                ${items.map((item) =>
                  options?.error
                    ? html`
                        <div class="usage-error-row">
                          <div class="usage-error-date">${item.label}</div>
                          <div class="usage-error-rate">${item.value}</div>
                          ${item.sub ? html`<div class="usage-error-sub">${item.sub}</div>` : nothing}
                        </div>
                      `
                    : html`
                        <div class="usage-list-item">
                          <span
                            >${item.agentId ? renderAgentRowChip(item.agentId) : item.label}</span
                          >
                          <span class="usage-list-value">
                            <span>${item.value}</span>
                            ${
                              item.sub
                                ? html`<span class="usage-list-sub">${item.sub}</span>`
                                : nothing
                            }
                          </span>
                        </div>
                      `,
                )}
              </div>
            `
      }
    </div>
  `;
}

function focusSummaryHint(event: MouseEvent) {
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    target.focus();
  }
}

function renderSummaryStat(params: {
  hintId: string;
  title: string;
  hint: string;
  value: string | number;
  sub: string;
  tone?: "good" | "warn" | "bad";
  className?: string;
  compactValue?: boolean;
}) {
  const hintId = `usage-summary-hint-${params.hintId}`;
  const classes = [
    "stat",
    "usage-summary-card",
    params.className,
    params.tone ? `usage-summary-card--${params.tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const valueClasses = [
    "stat-value",
    "usage-summary-value",
    params.tone ?? "",
    params.compactValue ? "usage-summary-value--compact" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${classes}>
      <div class="usage-summary-title">
        ${params.title}
        <openclaw-tooltip open-on-click>
          <button
            id=${hintId}
            type="button"
            class="usage-summary-hint"
            aria-label=${params.title}
            @click=${focusSummaryHint}
          >
            ?
          </button>
          <!-- Shared tooltips dismiss pointer activation so action buttons never
               strand one open. This hint exists only to be read, so it opts in to
               click-to-open; the click handler still normalizes browsers that do
               not focus buttons on pointer activation. -->
          <span slot="content">${params.hint}</span>
        </openclaw-tooltip>
      </div>
      <div class=${valueClasses}>${params.value}</div>
      <div class="usage-summary-sub">${params.sub}</div>
    </div>
  `;
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
    return nothing;
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
    .map((day) => {
      const rate = day.errors / day.messages;
      return {
        label: formatDayLabel(day.date),
        value: `${(rate * 100).toFixed(2)}%`,
        sub: `${day.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${day.messages} ${t("usage.overview.messagesAbbrev")} · ${formatUsageTokens(day.tokens)}`,
        rate,
      };
    })
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map(({ rate: _rate, ...rest }) => rest);

  const costShare = (cost: number) =>
    showCostShares && totals.totalCost > 0
      ? t("usage.overview.costShare", { percent: ((cost / totals.totalCost) * 100).toFixed(1) })
      : null;
  const costAttributionSub = (cost: number, tokens: number, messageCount?: number) =>
    [
      costShare(cost),
      formatUsageTokens(tokens),
      messageCount === undefined ? null : `${messageCount} ${t("usage.overview.messagesAbbrev")}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");

  const topModels = aggregates.byModel.slice(0, 5).map((entry) => ({
    label: entry.model ?? t("usage.common.unknown"),
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens, entry.count),
  }));
  const topProviders = aggregates.byProvider.slice(0, 5).map((entry) => ({
    label: entry.provider ?? t("usage.common.unknown"),
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens, entry.count),
  }));
  const topTools = aggregates.tools.tools.slice(0, 6).map((tool) => ({
    label: tool.name,
    value: `${tool.count}`,
    sub: t("usage.overview.calls"),
  }));
  const topAgents = aggregates.byAgent.slice(0, 5).map((entry) => ({
    label: entry.agentId,
    agentId: entry.agentId,
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens),
  }));
  const topChannels = aggregates.byChannel.slice(0, 5).map((entry) => ({
    label: entry.channel,
    value: formatAnalysisCost(entry.totals.totalCost),
    sub: costAttributionSub(entry.totals.totalCost, entry.totals.totalTokens),
  }));
  const insightLists = [
    ["usage.overview.topModels", topModels, "usage.overview.noModelData"],
    ["usage.overview.topProviders", topProviders, "usage.overview.noProviderData"],
    ["usage.overview.topTools", topTools, "usage.overview.noToolCalls"],
    ["usage.overview.topAgents", topAgents, "usage.overview.noAgentData"],
    ["usage.overview.topChannels", topChannels, "usage.overview.noChannelData"],
  ] as const;

  return renderSettingsSection(
    { title: t("usage.overview.title") },
    html`
      <section class="usage-panel usage-overview-card">
        <div class="usage-overview-layout">
          <div class="usage-summary-grid">
            ${renderSummaryStat({
              hintId: "messages",
              title: t("usage.overview.messages"),
              hint: t("usage.overview.messagesHint"),
              value: aggregates.messages.total,
              sub: `${aggregates.messages.user} ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} · ${aggregates.messages.assistant} ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`,
              className: "usage-summary-card--hero",
            })}
            ${renderSummaryStat({
              hintId: "throughput",
              title: t("usage.overview.throughput"),
              hint: t("usage.overview.throughputHint"),
              value: throughputLabel,
              sub: throughputCostLabel,
              className: "usage-summary-card--hero usage-summary-card--throughput",
              compactValue: true,
            })}
            ${renderSummaryStat({
              hintId: "tool-calls",
              title: t("usage.overview.toolCalls"),
              hint: t("usage.overview.toolCallsHint"),
              value: aggregates.tools.totalCalls,
              sub: `${aggregates.tools.uniqueTools} ${t("usage.overview.toolsUsed")}`,
              className: "usage-summary-card--half",
            })}
            ${renderSummaryStat({
              hintId: "average-tokens",
              title: t("usage.overview.avgTokens"),
              hint: t("usage.overview.avgTokensHint"),
              value: formatUsageTokens(avgTokens),
              sub: t("usage.overview.acrossMessages", {
                count: String(aggregates.messages.total || 0),
              }),
              className: "usage-summary-card--half",
            })}
            ${renderSummaryStat({
              hintId: "cache-hit-rate",
              title: t("usage.overview.cacheHitRate"),
              hint: t("usage.overview.cacheHint"),
              value: cacheHitLabel,
              sub: `${formatUsageTokens(totals.cacheRead)} ${t("usage.overview.cached")} · ${formatUsageTokens(cacheBase)} ${t("usage.overview.prompt")}`,
              tone: cacheHitRate > 0.6 ? "good" : cacheHitRate > 0.3 ? "warn" : "bad",
              className: "usage-summary-card--medium",
            })}
            ${renderSummaryStat({
              hintId: "error-rate",
              title: t("usage.overview.errorRate"),
              hint: t("usage.overview.errorHint"),
              value: `${errorRatePct.toFixed(2)}%`,
              sub: `${aggregates.messages.errors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${avgDurationLabel} ${t("usage.overview.avgSession")}`,
              tone: errorRatePct > 5 ? "bad" : errorRatePct > 1 ? "warn" : "good",
              className: "usage-summary-card--medium",
            })}
            ${renderSummaryStat({
              hintId: "average-cost",
              title: t("usage.overview.avgCost"),
              hint: t(
                showCostHint ? "usage.overview.avgCostHintMissing" : "usage.overview.avgCostHint",
              ),
              value: formatAnalysisCost(avgCost),
              sub: `${formatAnalysisCost(totals.totalCost)} ${normalizeLowercaseStringOrEmpty(t("usage.breakdown.total"))}`,
              className: "usage-summary-card--compact",
            })}
            ${renderSummaryStat({
              hintId: "sessions",
              title: t("usage.overview.sessions"),
              hint: t("usage.overview.sessionsHint"),
              value: sessionCount,
              sub: t("usage.overview.sessionsInRange", { count: String(totalSessions) }),
              className: "usage-summary-card--compact",
            })}
            ${renderSummaryStat({
              hintId: "errors",
              title: t("usage.overview.errors"),
              hint: t("usage.overview.errorsHint"),
              value: aggregates.messages.errors,
              sub: `${aggregates.messages.toolResults} ${t("usage.overview.toolResults")}`,
              className: "usage-summary-card--compact",
            })}
          </div>
          <div class="usage-insights-grid">
            ${insightLists.map(([titleKey, items, emptyKey]) =>
              renderInsightList(t(titleKey), items, t(emptyKey)),
            )}
            ${renderInsightList(
              t("usage.overview.peakErrorDays"),
              errorDays,
              t("usage.overview.noErrorData"),
              { error: true },
            )}
            ${renderInsightList(
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
    `,
  );
}

function renderSessionsCard(
  sessions: UsageSessionEntry[],
  selectedSessions: string[],
  selectedDays: string[],
  isTokenMode: boolean,
  sessionSort: "tokens" | "cost" | "recent" | "messages" | "errors",
  sessionSortDir: "asc" | "desc",
  recentSessions: string[],
  sessionsTab: "all" | "recent",
  onSelectSession: (key: string, shiftKey: boolean, orderedKeys: string[]) => void,
  onSessionSortChange: (sort: "tokens" | "cost" | "recent" | "messages" | "errors") => void,
  onSessionSortDirChange: (dir: "asc" | "desc") => void,
  onSessionsTabChange: (tab: "all" | "recent") => void,
  visibleColumns: UsageColumnId[],
  totalSessions: number,
  onClearSessions: () => void,
) {
  const showColumn = (id: UsageColumnId) => visibleColumns.includes(id);
  const showAgent =
    showColumn("agent") || new Set(sessions.map((session) => session.agentId)).size > 1;
  const formatSessionListLabel = (s: UsageSessionEntry): string => {
    const raw = s.label || s.key;
    // Agent session keys often include a token query param; remove it for readability.
    if (raw.startsWith("agent:") && raw.includes("?token=")) {
      return raw.slice(0, raw.indexOf("?token="));
    }
    return raw;
  };
  const buildSessionMeta = (session: UsageSessionEntry): string[] =>
    [
      showColumn("channel") && session.channel && `channel:${session.channel}`,
      showColumn("provider") &&
        (session.modelProvider || session.providerOverride) &&
        `provider:${session.modelProvider ?? session.providerOverride}`,
      showColumn("model") && session.model && `model:${session.model}`,
      showColumn("messages") &&
        session.usage?.messageCounts &&
        `msgs:${session.usage.messageCounts.total}`,
      showColumn("tools") &&
        session.usage?.toolUsage &&
        `tools:${session.usage.toolUsage.totalCalls}`,
      showColumn("errors") &&
        session.usage?.messageCounts &&
        `errors:${session.usage.messageCounts.errors}`,
      showColumn("duration") &&
        session.usage?.durationMs &&
        `dur:${formatDurationCompact(session.usage.durationMs) ?? "—"}`,
    ].filter((part): part is string => typeof part === "string" && part.length > 0);

  const selectedDaySet = new Set(selectedDays);

  const sortedSessions = sessions
    .map((session) => {
      const usage = session.usage;
      let tokens = usage?.totalTokens ?? 0;
      let cost = usage?.totalCost ?? 0;
      const daily = selectedDaySet.size > 0 ? usage?.dailyBreakdown : undefined;
      if (daily?.length) {
        tokens = 0;
        cost = 0;
        for (const day of daily) {
          if (selectedDaySet.has(day.date)) {
            tokens += day.tokens;
            cost += day.cost;
          }
        }
      }
      let sortValue: number;
      switch (sessionSort) {
        case "recent":
          sortValue = session.updatedAt ?? 0;
          break;
        case "messages":
          sortValue = usage?.messageCounts?.total ?? 0;
          break;
        case "errors":
          sortValue = usage?.messageCounts?.errors ?? 0;
          break;
        case "cost":
          sortValue = cost;
          break;
        case "tokens":
          sortValue = tokens;
          break;
      }
      return {
        session,
        displayLabel: formatSessionListLabel(session),
        value: isTokenMode ? tokens : cost,
        sortValue,
      };
    })
    .toSorted((a, b) => {
      const valueDiff = b.sortValue - a.sortValue;
      if (valueDiff !== 0) {
        return valueDiff;
      }
      const recentDiff = (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
      if (recentDiff !== 0) {
        return recentDiff;
      }
      return a.displayLabel.localeCompare(b.displayLabel);
    });
  const sortedWithDir = sessionSortDir === "asc" ? sortedSessions.toReversed() : sortedSessions;

  const totalValue = sortedWithDir.reduce((sum, entry) => sum + entry.value, 0);
  const avgValue = sortedWithDir.length ? totalValue / sortedWithDir.length : 0;
  const totalErrors = sortedWithDir.reduce(
    (sum, entry) => sum + (entry.session.usage?.messageCounts?.errors ?? 0),
    0,
  );

  const renderSessionBarRow = (
    entry: (typeof sortedSessions)[number],
    isSelected: boolean,
    orderedKeys: string[],
  ) => {
    const { session: s, value, displayLabel } = entry;
    const meta = buildSessionMeta(s);
    return html`
      <div
        class="session-bar-row ${isSelected ? "selected" : ""}"
        @click=${(event: MouseEvent) => {
          if ((event.target as Element | null)?.closest("button")) {
            return;
          }
          onSelectSession(s.key, event.shiftKey, orderedKeys);
        }}
        title="${s.key}"
      >
        <button
          type="button"
          class="session-bar-selection"
          aria-label=${displayLabel}
          aria-pressed=${isSelected ? "true" : "false"}
          @click=${(event: MouseEvent) => onSelectSession(s.key, event.shiftKey, orderedKeys)}
        >
          <span class="session-bar-label">
            <span class="session-bar-title">${displayLabel}</span>
            ${showAgent && s.agentId ? renderAgentRowChip(s.agentId) : nothing}
            ${
              meta.length > 0
                ? html`<span class="session-bar-meta">${meta.join(" · ")}</span>`
                : nothing
            }
          </span>
        </button>
        <div class="session-bar-actions">
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            @click=${(e: MouseEvent) => {
              e.stopPropagation();
              void handleCopyButton(e, displayLabel, t("usage.sessions.copy"));
            }}
          >
            <span data-copy-label>${t("usage.sessions.copy")}</span>
          </button>
          <div class="session-bar-value">
            ${isTokenMode ? formatUsageTokens(value) : formatAnalysisCost(value)}
          </div>
        </div>
      </div>
    `;
  };

  const selectedSet = new Set(selectedSessions);
  const selectedEntries = sortedWithDir.filter((entry) => selectedSet.has(entry.session.key));
  const selectedCount = selectedEntries.length;
  const sessionMap = new Map(sortedWithDir.map((entry) => [entry.session.key, entry]));
  const recentEntries = recentSessions
    .map((key) => sessionMap.get(key))
    .filter((entry) => entry !== undefined);
  const displayedEntries = sessionsTab === "recent" ? recentEntries : sortedWithDir.slice(0, 50);
  const renderSessionBarRows = (entries: typeof sortedSessions) => {
    // Selection follows this rendered group, before a click reorders recently viewed sessions.
    const orderedKeys = entries.map((entry) => entry.session.key);
    return entries.map((entry) =>
      renderSessionBarRow(entry, selectedSet.has(entry.session.key), orderedKeys),
    );
  };

  return renderSettingsSection(
    { title: t("usage.sessions.title") },
    html`
      <div class="usage-panel sessions-card">
        <div class="sessions-card-header">
          <div class="sessions-card-count">
            ${t("usage.sessions.shown", { count: String(displayedEntries.length) })}
            ${
              totalSessions !== displayedEntries.length
                ? ` · ${t("usage.sessions.total", { count: String(totalSessions) })}`
                : ""
            }
          </div>
        </div>
        <div class="sessions-card-meta">
          <div class="sessions-card-stats">
            <span>
              ${isTokenMode ? formatUsageTokens(avgValue) : formatAnalysisCost(avgValue)}
              ${t("usage.sessions.avg")}
            </span>
            <span
              >${totalErrors} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))}</span
            >
          </div>
          ${renderSettingsSegmented({
            mode: "buttons",
            variant: "accent",
            ariaPressed: false,
            className: "small",
            value: sessionsTab,
            onChange: onSessionsTabChange,
            onReselect: onSessionsTabChange,
            options: [
              { value: "all", label: t("usage.sessions.all") },
              { value: "recent", label: t("usage.sessions.recent") },
            ],
          })}
          <label class="sessions-sort">
            <span>${t("usage.sessions.sort")}</span>
            <select
              class="settings-select"
              @change=${(e: Event) =>
                onSessionSortChange((e.target as HTMLSelectElement).value as typeof sessionSort)}
            >
              ${Object.entries({
                cost: "usage.metrics.cost",
                errors: "usage.overview.errors",
                messages: "usage.overview.messages",
                recent: "usage.sessions.recentShort",
                tokens: "usage.metrics.tokens",
              }).map(
                ([value, labelKey]) =>
                  html`<option value=${value} ?selected=${sessionSort === value}>
                    ${t(labelKey)}
                  </option>`,
              )}
            </select>
          </label>
          <openclaw-tooltip
            .content=${
              sessionSortDir === "desc"
                ? t("usage.sessions.descending")
                : t("usage.sessions.ascending")
            }
          >
            <button
              class="btn btn--sm"
              aria-label=${
                sessionSortDir === "desc"
                  ? t("usage.sessions.descending")
                  : t("usage.sessions.ascending")
              }
              @click=${() => onSessionSortDirChange(sessionSortDir === "desc" ? "asc" : "desc")}
            >
              ${sessionSortDir === "desc" ? "↓" : "↑"}
            </button>
          </openclaw-tooltip>
          ${
            selectedCount > 0
              ? html`
                  <button class="btn btn--sm" @click=${onClearSessions}>
                    ${t("usage.sessions.clearSelection")}
                  </button>
                `
              : nothing
          }
        </div>
        ${
          sessionsTab === "recent"
            ? displayedEntries.length === 0
              ? html` <div class="usage-empty-block">${t("usage.sessions.noRecent")}</div> `
              : html`
                  <div class="session-bars session-bars--recent">
                    ${renderSessionBarRows(displayedEntries)}
                  </div>
                `
            : displayedEntries.length === 0
              ? html` <div class="usage-empty-block">${t("usage.sessions.noneInRange")}</div> `
              : html`
                  <div class="session-bars">
                    ${renderSessionBarRows(displayedEntries)}
                    ${
                      sessions.length > displayedEntries.length
                        ? html`
                            <div class="usage-more-sessions">
                              ${t("usage.sessions.more", {
                                count: String(sessions.length - displayedEntries.length),
                              })}
                            </div>
                          `
                        : nothing
                    }
                  </div>
                `
        }
        ${
          selectedCount > 1
            ? html`
                <div class="sessions-selected-group">
                  <div class="sessions-card-count">
                    ${t("usage.sessions.selected", { count: String(selectedCount) })}
                  </div>
                  <div class="session-bars session-bars--selected">
                    ${renderSessionBarRows(selectedEntries)}
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    `,
  );
}

export {
  renderCostWindowComparison,
  renderFilterChips,
  renderInsightList,
  renderSessionsCard,
  renderUsageInsights,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
