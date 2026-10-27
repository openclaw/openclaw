import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { For, Show, createMemo, createSignal } from "solid-js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { ProviderUsagePanel } from "../../components/solid/provider-usage.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
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

function SummaryStat(props: {
  hintId: string;
  metric: string;
  hint?: string;
  value: string | number;
  sub: string;
  tone?: "good" | "warn" | "bad";
  compactValue?: boolean;
}) {
  return (
    <div
      class={[
        "stat usage-summary-card",
        props.tone ? `usage-summary-card--${props.tone}` : undefined,
      ]}
    >
      <div class="usage-summary-title">
        {t(`usage.overview.${props.metric}`)}
        <openclaw-tooltip open-on-click>
          <button
            id={`usage-summary-hint-${props.hintId}`}
            type="button"
            class="usage-summary-hint"
            aria-label={t(`usage.overview.${props.metric}`)}
            onClick={(event) => event.currentTarget.focus()}
          >
            ?
          </button>
          {/* Summary hints intentionally remain open on pointer activation. */}
          <span slot="content">{props.hint ?? t(`usage.overview.${props.metric}Hint`)}</span>
        </openclaw-tooltip>
      </div>
      <div
        class={[
          "stat-value usage-summary-value",
          props.tone,
          { "usage-summary-value--compact": props.compactValue },
        ]}
      >
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
      <div class="usage-summary-sub">{props.sub}</div>
    </div>
  );
}

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
function windowDailyCosts(costs: Map<string, CostDailyEntry>, endDate: string, days: number) {
  if (days < 2 || days > 92) {
    return null;
  }
  const start = Date.parse(endDate) - (days - 1) * 86_400_000;
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
    const entry = costs.get(date);
    return { date, cost: entry?.totalCost ?? 0, usageReport: entry?.usageReport };
  });
}

/** Mini daily columns: tinted by value, the newest day in full accent, a readout on hover. */
function CostColumns(props: {
  days: NonNullable<ReturnType<typeof windowDailyCosts>>;
  label: string;
}) {
  const max = createMemo(() => Math.max(0, ...props.days.map((day) => day.cost)));
  const [hover, setHover] = createSignal<number | null>(null);
  const active = () => {
    const index = hover();
    return index === null ? undefined : props.days[index];
  };
  return (
    <div
      class="usage-bars"
      role="img"
      aria-label={props.label}
      onPointerLeave={() => setHover(null)}
    >
      <For each={props.days}>
        {(day, index) => {
          const share = () => (max() > 0 ? day.cost / max() : 0);
          return (
            <span
              class={[
                "usage-bars__bar",
                {
                  "usage-bars__bar--current": index() === props.days.length - 1,
                  "usage-bars__bar--hover": hover() === index(),
                },
              ]}
              style={{
                height: `${day.cost > 0 ? Math.max(6, share() * 100) : 0}%`,
                "--usage-bar-tint": `${Math.round(35 + share() * 50)}%`,
              }}
              onPointerEnter={() => setHover(index())}
            />
          );
        }}
      </For>
      <Show when={active()}>
        {(day) => (
          <span class="usage-bars__tip">
            {formatDayLabel(day().date)} ·{" "}
            <b>{formatAnalysisCost(day().cost, day().usageReport)}</b>
          </span>
        )}
      </Show>
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
  const costs = new Map(daily.map((day) => [day.date, day]));
  const comparisons = windows.map((summary, index) => ({
    index,
    summary,
    columns: windowDailyCosts(costs, summary.endDate, summary.days),
  }));

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
        <For each={comparisons}>
          {({ index, summary, columns }) => {
            const label = createMemo(() =>
              index === 0
                ? t("usage.costWindows.selectedRange")
                : summary.days === 1
                  ? summary.endDate === today
                    ? t("usage.presets.today")
                    : formatDayLabel(summary.endDate)
                  : t("usage.costWindows.lastDays", { count: String(summary.days) }),
            );
            return (
              <div class={["cost-window", { "cost-window--range": index === 0 }]}>
                <div class="cost-window__label">{label()}</div>
                <div class="cost-window__value">
                  {formatAnalysisCost(summary.totals.totalCost, summary.totals.usageReport)}
                </div>
                <div class="cost-window__meta">
                  {formatUsageTokens(summary.totals.totalTokens, summary.totals.usageReport)}{" "}
                  {normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
                  {summary.days > 1
                    ? ` · ${formatAnalysisCost(summary.totals.totalCost / summary.days, summary.totals.usageReport)} ${t("usage.costWindows.perDay")}`
                    : undefined}
                </div>
                {columns ? <CostColumns days={columns} label={label()} /> : undefined}
              </div>
            );
          }}
        </For>
      </div>
    </SettingsSection>
  );
}

type InsightItem = { label: string; value: string; sub?: string; agentId?: string; weight: number };

function renderInsightList(
  title: string,
  items: InsightItem[],
  emptyLabel: string,
  options?: {
    listClassName?: string;
    error?: boolean;
  },
) {
  // Bars compare rows within one list; the leader fills the track.
  const max = Math.max(0, ...items.map((item) => item.weight));
  const share = (item: InsightItem) => (max > 0 ? (item.weight / max) * 100 : 0);
  return (
    <div class="usage-insight-card">
      <div class="usage-insight-title">{title}</div>
      {items.length === 0 ? (
        <div class="muted">{emptyLabel}</div>
      ) : (
        <div
          class={[
            "usage-list",
            { "usage-list--error": options?.error === true },
            options?.listClassName,
          ]}
        >
          <For each={items}>
            {(item, index) => (
              <div class={["usage-list-item", { "usage-list-item--lead": index() === 0 }]}>
                <span class="usage-list-label" title={item.label}>
                  {item.agentId ? <AgentRowChip agentId={item.agentId} /> : item.label}
                </span>
                <span class="usage-list-value">{item.value}</span>
                <span class="usage-list-bar" aria-hidden="true">
                  <span style={{ width: `${share(item)}%` }} />
                </span>
                {item.sub ? <span class="usage-list-sub">{item.sub}</span> : undefined}
              </div>
            )}
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
  errorHours: InsightItem[];
  sessionCount: number;
  totalSessions: number;
}) {
  const state = createMemo(() => {
    const totals = props.totals;
    const aggregates = props.aggregates;
    const stats = props.stats;
    if (!totals) {
      return undefined;
    }

    // Ratios of partial counters are neither exact nor lower bounds.
    const report = totals.usageReport;
    const partial = report?.state === "unavailable";
    const empty = t("usage.common.emptyValue");
    const avgTokens = aggregates.messages.total
      ? Math.round(totals.totalTokens / aggregates.messages.total)
      : 0;
    const avgCost = aggregates.messages.total ? totals.totalCost / aggregates.messages.total : 0;
    const cacheBase = totals.input + totals.cacheRead + totals.cacheWrite;
    const cacheHitRate = cacheBase > 0 ? totals.cacheRead / cacheBase : 0;
    const cacheHitLabel = cacheBase > 0 && !partial ? `${(cacheHitRate * 100).toFixed(1)}%` : empty;
    const errorRatePct = stats.errorRate * 100;
    const throughputLabel =
      stats.throughputTokensPerMin !== undefined && !partial
        ? `${formatUsageTokens(Math.round(stats.throughputTokensPerMin))} ${t("usage.overview.tokensPerMinute")}`
        : t("usage.common.emptyValue");
    const throughputCostLabel =
      stats.throughputCostPerMin !== undefined && !partial
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
        weight: day.errors / day.messages,
        sub: `${day.errors.toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${day.messages.toLocaleString()} ${t("usage.overview.messagesAbbrev")} · ${formatUsageTokens(day.tokens, day.usageReport)}`,
      }));

    const costAttribution = (
      label: string,
      { totals: entryTotals, count }: { totals: UsageTotals; count?: number },
      { agent = false, source }: { agent?: boolean; source?: string } = {},
    ) => ({
      label,
      ...(agent ? { agentId: label } : {}),
      // Usage with no known price is unpriced, never free.
      value:
        entryTotals.totalCost === 0 && entryTotals.missingCostEntries > 0
          ? t("usage.overview.unpriced")
          : formatAnalysisCost(entryTotals.totalCost, entryTotals.usageReport),
      // Bars rank by cost, which reflects model, speed tier and cache use better than tokens.
      weight: entryTotals.totalCost || entryTotals.totalTokens / 1e9,
      sub: [
        source ?? null,
        formatUsageTokens(entryTotals.totalTokens, entryTotals.usageReport),
        count === undefined
          ? null
          : `${count.toLocaleString()} ${t("usage.overview.messagesAbbrev")}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    });

    // Rows with no tokens and no cost (e.g. delivery mirrors) carry no usage worth ranking.
    const used = (entry: { totals: UsageTotals }) =>
      entry.totals.totalTokens > 0 || entry.totals.totalCost > 0;
    const topModels = aggregates.byModel
      .filter(used)
      .slice(0, 5)
      // The same model name can come from two providers, so each row names its provider.
      .map((entry) =>
        costAttribution(
          entry.model ?? t("usage.common.unknown"),
          entry,
          entry.provider ? { source: providerDisplayLabel(entry.provider) } : {},
        ),
      );
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
      .filter(used)
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
      weight: tool.count,
    }));
    const topAgents = aggregates.byAgent
      .filter(used)
      .slice(0, 5)
      .map((entry) => costAttribution(entry.agentId, entry, { agent: true }));
    const topChannels = aggregates.byChannel
      .filter(used)
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
      avgTokensLabel: partial ? empty : formatUsageTokens(avgTokens),
      avgCostLabel: partial ? empty : formatAnalysisCost(avgCost),
      partial,
      report,
      cacheHitLabel,
      totals,
      cacheBase,
      cacheHitRate,
      errorRatePct,
      avgDurationLabel,
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
                  value={insights().avgTokensLabel}
                  sub={t("usage.overview.acrossMessages", {
                    count: (insights().aggregates.messages.total || 0).toLocaleString(),
                  })}
                />
                <SummaryStat
                  hintId="cache-hit-rate"
                  metric="cacheHitRate"
                  hint={t("usage.overview.cacheHint")}
                  value={insights().cacheHitLabel}
                  sub={`${formatUsageTokens(insights().totals.cacheRead, insights().report)} ${t("usage.overview.cached")} · ${formatUsageTokens(insights().cacheBase, insights().report)} ${t("usage.overview.prompt")}`}
                  tone={
                    insights().partial
                      ? undefined
                      : insights().cacheHitRate > 0.6
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
                  value={insights().avgCostLabel}
                  sub={`${formatAnalysisCost(insights().totals.totalCost, insights().report)} ${normalizeLowercaseStringOrEmpty(t("usage.breakdown.total"))}`}
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

export function renderProviderUsage(
  providers: ProviderUsageSummary["providers"][number][],
  unavailable: boolean,
  stalled: boolean,
) {
  const notice =
    stalled || unavailable ? (
      <div class="callout warning usage-callout">
        {t(stalled ? "usage.providerUsage.stalled" : "usage.providerUsage.unavailable")}
      </div>
    ) : undefined;
  if (providers.length === 0) {
    return notice;
  }
  return (
    <SettingsSection
      title={t("usage.providerUsage.title")}
      count={providers.length}
      description={t("usage.providerUsage.subtitle")}
    >
      {notice}
      <div class="usage-panel provider-usage-section">
        <div class="provider-usage-grid">
          <For each={providers}>
            {(provider) => (
              <article class="provider-usage-card">
                <div class="provider-usage-card__header">
                  <div>
                    <div class="provider-usage-card__name">{provider.displayName}</div>
                    <div class="provider-usage-card__id">{provider.provider}</div>
                  </div>
                  {provider.plan ? (
                    <>
                      {" "}
                      <span class="provider-usage-plan">{provider.plan}</span>{" "}
                    </>
                  ) : undefined}
                </div>
                <ProviderUsagePanel usage={provider} />
              </article>
            )}
          </For>
        </div>
      </div>
    </SettingsSection>
  );
}

type UsageOverviewData = Pick<UsageProps["data"], "totals" | "sessions" | "costDaily" | "overview">;

export function usageOverview(data: UsageOverviewData, complete: boolean) {
  // Cold caches can list sessions before usage arrives. Zero-filled aggregates
  // are not evidence of zero usage while that read is pending.
  const awaitingUsage =
    !complete &&
    !data.totals?.totalTokens &&
    !data.totals?.totalCost &&
    !data.sessions.some(
      (session) =>
        session.usage?.computedAt !== undefined ||
        session.usage?.totalTokens ||
        session.usage?.totalCost,
    ) &&
    !data.costDaily.some((day) => day.totalTokens || day.totalCost);
  return {
    awaitingUsage,
    hasOverviewData:
      !awaitingUsage && Boolean(data.totals || data.sessions.length || data.costDaily.length),
    isEmpty:
      complete &&
      data.totals !== null &&
      data.sessions.length === 0 &&
      (data.overview?.unfilteredSessionCount ?? 0) === 0 &&
      (data.totals?.totalTokens ?? 0) === 0,
  };
}
