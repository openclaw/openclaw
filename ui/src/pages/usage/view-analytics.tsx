import { createMemo, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { UsageMosaic } from "./metrics-view.tsx";
import { buildPeakErrorHours } from "./metrics.ts";
import { renderUsageEmptyState } from "./page-shell.tsx";
import { buildProviderSeries } from "./provider-series.ts";
import type { UsageProps } from "./types.ts";
import { DailyChartCompact, CostBreakdownCompact } from "./view-chart.tsx";
import { UsageCreators } from "./view-creators.tsx";
import { SessionDetailPanel } from "./view-details.tsx";
import { UsageHeatmap } from "./view-heatmap.tsx";
import { renderCostWindowComparison, UsageInsights } from "./view-overview.tsx";
import { SessionsCard } from "./view-sessions-card.tsx";

export function overviewState(data: UsageProps["data"], pending: boolean) {
  // Cold caches can list sessions before any usage has been read. Zero-filled
  // aggregate objects are not evidence of zero usage while that read is pending.
  const awaitingUsage =
    data.cacheRefresh !== "complete" &&
    !data.totals?.totalTokens &&
    !data.totals?.totalCost &&
    !data.sessions.some(
      (session) =>
        session.usage?.computedAt !== undefined ||
        session.usage?.totalTokens ||
        session.usage?.totalCost,
    ) &&
    !data.costDaily.some((day) => day.totalTokens || day.totalCost);
  const hasOverviewData =
    !awaitingUsage && Boolean(data.totals || data.sessions.length || data.costDaily.length);
  const loadingOverview = pending || (awaitingUsage && data.cacheRefresh === "retrying");
  return { hasOverviewData, loadingOverview };
}

export function totalSessionCount(data: UsageProps["data"]) {
  return (
    data.overview?.unfilteredSessionCount ?? data.aggregates?.sessionCount ?? data.sessions.length
  );
}

export function selectedSessionCount(data: UsageProps["data"]) {
  return (
    data.overview?.selectedSessionCount ??
    data.overview?.total ??
    data.aggregates?.sessionCount ??
    data.sessions.length
  );
}

export function UsageLoading() {
  return (
    <div class="usage-panel usage-loading-card">
      <div class="usage-loading-grid">
        <div class="skeleton usage-skeleton-block usage-skeleton-block--tall" />
        <div class="skeleton usage-skeleton-block" />
        <div class="skeleton usage-skeleton-block" />
      </div>
    </div>
  );
}

export function UsageAnalytics(props: UsageProps & { loading: boolean }) {
  const loading = () => props.loading;
  const overview = createMemo(() => overviewState(props.data, loading()));
  const displayTotals = createMemo(() => (overview().hasOverviewData ? props.data.totals : null));
  const providerSeries = createMemo(() =>
    buildProviderSeries(props.data.aggregates?.modelDaily ?? []),
  );
  const primarySelectedEntry = createMemo(() =>
    props.filters.selectedSessions.length === 1 && props.data.overview?.selectedRowCount !== 0
      ? (props.data.selectedSession ??
        props.data.sessions.find((session) => session.key === props.filters.selectedSessions[0]))
      : null,
  );
  const activeAggregates = createMemo(
    () =>
      props.data.aggregates ?? {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
  );
  const totalSessions = () => totalSessionCount(props.data);
  const displaySessionCount = createMemo(() => selectedSessionCount(props.data));
  const insightStats = createMemo(() => {
    const durationMs = props.data.overview?.durationMs ?? 0;
    const durationCount = props.data.overview?.durationCount ?? 0;
    const totals = displayTotals();
    const messages = activeAggregates().messages;
    return {
      durationCount,
      avgDurationMs: durationCount ? durationMs / durationCount : 0,
      throughputTokensPerMin:
        totals && durationMs > 0 ? totals.totalTokens / (durationMs / 60000) : undefined,
      throughputCostPerMin:
        totals && durationMs > 0 ? totals.totalCost / (durationMs / 60000) : undefined,
      errorRate: messages.total ? messages.errors / messages.total : 0,
    };
  });
  // Zero totals are normal while idle; an error must keep its own explanation.
  const isEmpty = () =>
    props.data.cacheRefresh === "complete" &&
    props.data.totals !== null &&
    !loading() &&
    !props.data.error &&
    props.data.sessions.length === 0 &&
    (props.data.overview?.unfilteredSessionCount ?? 0) === 0 &&
    (props.data.totals?.totalTokens ?? 0) === 0;
  return (
    <>
      {!overview().hasOverviewData ? (
        overview().loadingOverview ? (
          <UsageLoading />
        ) : undefined
      ) : isEmpty() ? (
        renderUsageEmptyState(() => void props.callbacks.filters.onRefresh())
      ) : (
        <>
          <div class="settings-group usage-panel usage-left-card usage-trend-section">
            {
              <DailyChartCompact
                dailyEntries={props.data.costDaily}
                selectedDays={props.filters.selectedDays}
                chartMode={props.display.chartMode}
                dailyChartMode={props.display.dailyChartMode}
                onDailyChartModeChange={(dailyChartMode) =>
                  props.callbacks.display.onChange({ dailyChartMode })
                }
                onSelectDay={props.callbacks.filters.onSelectDay}
                providerSeries={providerSeries()}
                range={{
                  startDate: props.filters.startDate,
                  endDate: props.filters.endDate,
                  complete: props.data.cacheRefresh === "complete",
                }}
              />
            }
            <Show when={displayTotals()}>
              {(totals) => (
                <CostBreakdownCompact totals={totals()} mode={props.display.chartMode} />
              )}
            </Show>
          </div>
          <UsageCreators
            groups={activeAggregates().byCreator ?? []}
            selectedKey={props.filters.creatorKey}
            mode={props.display.chartMode}
            onSelect={(creatorKey) => props.callbacks.filters.onScopeChange({ creatorKey })}
          />
          <UsageInsights
            totals={displayTotals()}
            aggregates={activeAggregates()}
            stats={insightStats()}
            showCostHint={(displayTotals()?.missingCostEntries ?? 0) > 0}
            errorHours={buildPeakErrorHours(
              props.data.overview?.hourlyMessages ?? [],
              props.data.overview?.hourlyErrors ?? [],
            )}
            sessionCount={displaySessionCount()}
            totalSessions={totalSessions()}
          />
          {renderCostWindowComparison(
            props.data.costDaily,
            props.filters.startDate,
            props.filters.endDate,
            props.filters.timeZone,
          )}
          <UsageHeatmap
            daily={props.data.costDaily}
            rangeStartDate={props.filters.startDate}
            rangeEndDate={props.filters.endDate}
          />
          {
            <UsageMosaic
              overview={props.data.overview}
              timeZone={props.filters.timeZone}
              selectedHours={props.filters.selectedHours}
              onSelectHour={props.callbacks.filters.onSelectHour}
            />
          }

          <div class="usage-grid">
            <div class="usage-grid-column">
              <SessionsCard
                sessions={props.data.sessions}
                usage={props}
                totalSessions={props.data.overview?.total ?? totalSessions()}
                overview={props.data.sessionPage ?? props.data.overview}
                loading={loading()}
              />
            </div>
            <Show when={primarySelectedEntry()}>
              {(selectedSession) => (
                // Details stack under the session list so the page stays one column.
                <aside class="usage-grid-column" aria-label={t("usage.sessions.details")}>
                  <SessionDetailPanel
                    session={selectedSession()}
                    detail={props.detail}
                    callbacks={props.callbacks.details}
                    range={props.filters}
                    contextExpanded={props.display.contextExpanded}
                    onClose={() => props.callbacks.filters.onClearSessions()}
                  />
                </aside>
              )}
            </Show>
          </div>
        </>
      )}
    </>
  );
}
