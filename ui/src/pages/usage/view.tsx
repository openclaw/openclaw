import { For, Show, createMemo, onSettled } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import "../../components/tooltip.ts";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../styles/usage.css";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { isUsageCacheIncomplete } from "./cache-status.ts";
import { UsageMosaic } from "./metrics-view.tsx";
import { buildPeakErrorHours, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageEmptyState } from "./page-shell.tsx";
import { createUsagePhoneLayout } from "./phone-layout.ts";
import { buildProviderSeries } from "./provider-series.ts";
import { createUsageRead, UsagePending, UsageReadStatus, type UsageRead } from "./read-status.tsx";
import { createSessionDetailReveal } from "./session-detail-reveal.ts";
import { selectUsageExport, usageDisplaySessionCount, usageExportItems } from "./view-actions.tsx";
import { DailyChartCompact, CostBreakdownCompact } from "./view-chart.tsx";
import { createUsageControls, type UsageControlsProps } from "./view-controls.tsx";
import { UsageCreators } from "./view-creators.tsx";
import { UsageHeatmap } from "./view-heatmap.tsx";
import {
  CostWindowComparison,
  renderFilterChips,
  renderProviderUsage,
  UsageInsights,
  usageOverview,
} from "./view-overview.tsx";
import { UsageSessionsGrid } from "./view-sessions-grid.tsx";

registerEnglishCatalog(registerUsageEnglish);

export function renderUsage(props: UsageControlsProps) {
  const read = createUsageRead(
    () => props.data.read,
    () => props.data.error,
  );
  return (
    <UsagePending read={read}>
      {(loading) => <UsageView {...props} loading={loading()} read={read} />}
    </UsagePending>
  );
}

function UsageView(props: UsageControlsProps & { loading: boolean; read: UsageRead }) {
  // The report can replace its grid while a row selection is still being revealed.
  const reveal = createSessionDetailReveal();
  onSettled(() => reveal.dispose);
  const loading = () => props.loading;
  const phone = createUsagePhoneLayout();
  // Status reads would enlist retained chart eligibility in the request's retry lifecycle.
  const overview = createMemo(() =>
    usageOverview(props.data, props.data.cacheRefresh === "complete"),
  );
  const loadingOverview = () =>
    loading() || (overview().awaitingUsage && props.data.cacheRefresh === "retrying");
  // A text query hides the old charts, but keeps their date-keyed DOM alive.
  // The owner's calendar policy separately keeps day-selection controls live.
  const retainedChartSnapshot = createMemo(() => props.data.readChartSnapshot("filterOptions"));
  // Retain presentation only within the owner's strict scope while its text query changes.
  const analyticsData = createMemo(() => retainedChartSnapshot() ?? props.data);
  const analyticsTotals = () => analyticsData().totals;
  const analyticsSessionCount = () =>
    analyticsData().overview?.selectedSessionCount ??
    analyticsData().overview?.total ??
    analyticsData().aggregates?.sessionCount ??
    analyticsData().sessions.length;
  const analyticsTotalSessions = () =>
    analyticsData().overview?.unfilteredSessionCount ??
    analyticsData().aggregates?.sessionCount ??
    analyticsData().sessions.length;
  const calendarSnapshot = createMemo(() => props.data.readChartSnapshot("calendar"));
  const chartSnapshot = createMemo(() => calendarSnapshot() ?? retainedChartSnapshot());
  const retainedCharts = createMemo(() => {
    const report = chartSnapshot();
    if (!report) {
      return false;
    }
    const state = usageOverview(
      {
        totals: report.totals,
        sessions: report.sessions,
        costDaily: report.aggregates.costDaily ?? [],
        overview: report.overview,
      },
      !isUsageCacheIncomplete(report.cacheStatus, undefined),
    );
    return state.hasOverviewData && !state.isEmpty;
  });
  const chartDaily = createMemo(
    () => chartSnapshot()?.aggregates.costDaily ?? props.data.costDaily,
  );
  const chartComplete = () => {
    const report = chartSnapshot();
    return report
      ? !isUsageCacheIncomplete(report.cacheStatus, undefined)
      : props.data.cacheRefresh === "complete";
  };
  const providerSeries = createMemo(() =>
    buildProviderSeries(
      (retainedChartSnapshot()?.aggregates ?? props.data.aggregates)?.modelDaily ?? [],
    ),
  );
  const displayTotals = createMemo(() => (overview().hasOverviewData ? props.data.totals : null));
  const primarySelectedEntry = createMemo(() =>
    props.filters.selectedSessions.length === 1 && props.data.overview?.selectedRowCount !== 0
      ? (props.data.selectedSession ??
        props.data.sessions.find((session) => session.key === props.filters.selectedSessions[0]))
      : null,
  );
  const activeAggregates = createMemo(
    () =>
      analyticsData().aggregates ?? {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
  );
  const displaySessionCount = createMemo(() => usageDisplaySessionCount(props.data));
  const metricBadges = createMemo(() => {
    const totals = displayTotals();
    const empty = t("usage.common.emptyValue");
    const sessions = displaySessionCount();
    return [
      [totals ? formatUsageTokens(totals.totalTokens) : empty, t("usage.metrics.tokens")],
      [totals ? formatUsageCost(totals.totalCost) : empty, t("usage.metrics.cost")],
      [totals ? sessions.toLocaleString() : empty, t("usage.overview.sessions")],
    ];
  });
  const insightStats = createMemo(() => {
    const durationMs = analyticsData().overview?.durationMs ?? 0;
    const durationCount = analyticsData().overview?.durationCount ?? 0;
    const totals = analyticsTotals();
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
  const isEmpty = () => overview().isEmpty && !loading() && !props.data.error;
  const showAnalytics = () => overview().hasOverviewData && !isEmpty();
  const keepAnalytics = () =>
    showAnalytics() || (retainedCharts() && Boolean(retainedChartSnapshot()));
  const controls = createUsageControls(props, {
    loading,
    phone,
    hasOverviewData: () => overview().hasOverviewData,
    displaySessionCount,
    selectionChips: () =>
      renderFilterChips(props.data.overview?.selectedRows ?? props.data.sessions, props),
  });
  return (
    <SettingsPage wide>
      <div class="usage-page">
        <section class="usage-header-section">
          <div class={["usage-header", { pinned: props.display.headerPinned && !phone() }]}>
            {controls.toolbar()}
            {controls.appliedFilters()}

            {/* Carapace summary strip: fixed cells, so placeholders and loaded totals share one layout. */}
            <div class="usage-summary-strip">
              <For each={metricBadges()}>
                {([value, label]) => (
                  <div class="usage-metric-badge">
                    <strong>{value}</strong> <small>{label}</small>
                  </div>
                )}
              </For>
              {phone() ? (
                <Show when={controls.partialNotice()}>
                  <div class="usage-summary-strip__actions">{controls.partialStatus()}</div>
                </Show>
              ) : (
                <div class="usage-summary-strip__actions">
                  {controls.partialStatus()}
                  <button
                    class={[
                      "btn btn--sm btn--icon usage-pin-btn",
                      { active: props.display.headerPinned },
                    ]}
                    aria-label={
                      props.display.headerPinned
                        ? t("usage.filters.pinned")
                        : t("usage.filters.pin")
                    }
                    aria-pressed={props.display.headerPinned ? "true" : "false"}
                    title={
                      props.display.headerPinned
                        ? t("usage.filters.pinned")
                        : t("usage.filters.pin")
                    }
                    onClick={() => props.callbacks.filters.onToggleHeaderPinned()}
                  >
                    <Icon name={props.display.headerPinned ? "pinOff" : "pin"} />
                  </button>
                  <Menu
                    id="usage-export"
                    label={t("usage.export.label")}
                    class="usage-export-menu"
                    triggerClass="btn btn--sm"
                    placement="bottom-end"
                    triggerAttributes={{ "aria-busy": props.data.exporting ? "true" : "false" }}
                    trigger={
                      <>{props.data.exporting ? t("common.loading") : t("usage.export.label")} ▾</>
                    }
                    items={usageExportItems(props, loading())}
                    onSelect={(item) => selectUsageExport(props, item.id)}
                  />
                </div>
              )}
            </div>
            {phone()
              ? undefined
              : renderFilterChips(props.data.overview?.selectedRows ?? props.data.sessions, props)}

            {controls.querySection()}

            <UsageReadStatus read={props.read}>
              {() =>
                props.data.error ? (
                  <InlineAlert tone="danger" class="usage-callout">
                    {props.data.error}
                  </InlineAlert>
                ) : undefined
              }
            </UsageReadStatus>
            {props.data.cacheRefresh === "failed" ? (
              <InlineAlert
                tone="warning"
                class="usage-callout usage-cache-warning"
                role="status"
                aria-live="polite"
              >
                {t("usage.cacheStatus.paused")}
              </InlineAlert>
            ) : undefined}
          </div>
        </section>

        {!overview().hasOverviewData ? (
          loadingOverview() ? (
            <div class="usage-panel usage-loading-card">
              <div class="usage-loading-grid">
                <div class="skeleton usage-skeleton-block usage-skeleton-block--tall" />
                <div class="skeleton usage-skeleton-block" />
                <div class="skeleton usage-skeleton-block" />
              </div>
            </div>
          ) : undefined
        ) : isEmpty() ? (
          renderUsageEmptyState(() => void props.callbacks.filters.onRefresh())
        ) : undefined}
        <Show when={showAnalytics() || retainedCharts()}>
          {(_shown) => (
            <div
              class="settings-group usage-panel usage-left-card usage-trend-section"
              hidden={!showAnalytics()}
              inert={!showAnalytics()}
              style={{ display: showAnalytics() ? undefined : "none" }}
            >
              <DailyChartCompact
                dailyEntries={chartDaily()}
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
                  complete: chartComplete(),
                }}
              />
              <Show when={keepAnalytics() && analyticsTotals()}>
                {(totals) => (
                  <CostBreakdownCompact totals={totals()} mode={props.display.chartMode} />
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={keepAnalytics()}>
          <div
            hidden={!showAnalytics()}
            inert={!showAnalytics()}
            style={{ display: showAnalytics() ? "contents" : "none" }}
          >
            <UsageCreators
              groups={activeAggregates().byCreator ?? []}
              selectedKey={props.filters.creatorKey}
              mode={props.display.chartMode}
              onSelect={(creatorKey) => props.callbacks.filters.onScopeChange({ creatorKey })}
            />
            <UsageInsights
              totals={analyticsTotals()}
              aggregates={activeAggregates()}
              stats={insightStats()}
              showCostHint={(analyticsTotals()?.missingCostEntries ?? 0) > 0}
              errorHours={buildPeakErrorHours(
                analyticsData().overview?.hourlyMessages ?? [],
                analyticsData().overview?.hourlyErrors ?? [],
              )}
              sessionCount={analyticsSessionCount()}
              totalSessions={analyticsTotalSessions()}
            />
            <CostWindowComparison
              daily={analyticsData().aggregates?.costDaily ?? props.data.costDaily}
              rangeStartDate={props.filters.startDate}
              rangeEndDate={props.filters.endDate}
              timeZone={props.filters.timeZone}
            />
          </div>
        </Show>
        <Show when={showAnalytics() || retainedCharts()}>
          {(_shown) => (
            <div
              hidden={!showAnalytics()}
              inert={!showAnalytics()}
              style={{ display: showAnalytics() ? "contents" : "none" }}
            >
              <UsageHeatmap
                daily={chartDaily()}
                rangeStartDate={props.filters.startDate}
                rangeEndDate={props.filters.endDate}
              />
            </div>
          )}
        </Show>
        <Show when={keepAnalytics()}>
          <div
            hidden={!showAnalytics()}
            inert={!showAnalytics()}
            style={{ display: showAnalytics() ? "contents" : "none" }}
          >
            <UsageMosaic
              overview={analyticsData().overview}
              timeZone={props.filters.timeZone}
              selectedHours={props.filters.selectedHours}
              onSelectHour={props.callbacks.filters.onSelectHour}
            />

            <UsageSessionsGrid
              usage={props}
              reveal={reveal}
              sessions={analyticsData().sessions}
              selectedRows={analyticsData().overview?.selectedRows ?? []}
              totalSessions={analyticsData().overview?.total ?? analyticsTotalSessions()}
              overview={
                retainedChartSnapshot()?.overview ?? props.data.sessionPage ?? props.data.overview
              }
              loading={loading()}
              selected={showAnalytics() ? primarySelectedEntry() : null}
            />
          </div>
        </Show>
        {renderProviderUsage(
          props.data.providerUsage,
          props.data.providerUsageUnavailable,
          props.data.providerUsageStalled,
        )}
      </div>
    </SettingsPage>
  );
}
