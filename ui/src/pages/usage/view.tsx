import { For, Show, createMemo } from "solid-js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsPage, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../components/tooltip.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../../styles/usage.css";
import { isUsageCacheIncomplete } from "./cache-status.ts";
import { formatIsoDate } from "./helpers.ts";
import { UsageMosaic } from "./metrics-view.tsx";
import { buildPeakErrorHours, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageEmptyState } from "./page-shell.tsx";
import { buildProviderSeries } from "./provider-series.ts";
import { applySuggestionToQuery, buildQuerySuggestions, removeQueryToken } from "./query.ts";
import { createUsageRead, UsagePending, UsageReadStatus, type UsageRead } from "./read-status.tsx";
import type { UsageProps } from "./types.ts";
import { DailyChartCompact, CostBreakdownCompact } from "./view-chart.tsx";
import { UsageCreatorFilter, UsageCreators } from "./view-creators.tsx";
import { SessionDetailPanel } from "./view-details.tsx";
import { UsageHeatmap } from "./view-heatmap.tsx";
import {
  renderCostWindowComparison,
  renderFilterChips,
  renderProviderUsage,
  UsageInsights,
  usageOverview,
} from "./view-overview.tsx";
import { UsageQueryFilter } from "./view-query-filter.tsx";
import { SessionsCard } from "./view-sessions-card.tsx";

registerEnglishCatalog(registerUsageEnglish);

function DateInput(props: { value: string; label: string; onChange: (value: string) => void }) {
  return (
    <input
      class="usage-date-input"
      type="date"
      value={props.value}
      title={props.label}
      aria-label={props.label}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    />
  );
}

export function renderUsage(props: UsageProps) {
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

function UsageView(props: UsageProps & { loading: boolean; read: UsageRead }) {
  const loading = () => props.loading;
  // Status reads would enlist retained chart eligibility in the request's retry lifecycle.
  const overview = createMemo(() =>
    usageOverview(props.data, props.data.cacheRefresh === "complete"),
  );
  const loadingOverview = () =>
    loading() || (overview().awaitingUsage && props.data.cacheRefresh === "retrying");
  // A text query hides the old charts, but keeps their date-keyed DOM alive.
  // The owner's calendar policy separately keeps day-selection controls live.
  const retainedChartSnapshot = createMemo(() => props.data.readChartSnapshot("filterOptions"));
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
  const partialNotice = () => props.data.partialNotice ?? "";
  const providerSeries = createMemo(() =>
    buildProviderSeries(
      (retainedChartSnapshot()?.aggregates ?? props.data.aggregates)?.modelDaily ?? [],
    ),
  );
  const displayTotals = createMemo(() => (overview().hasOverviewData ? props.data.totals : null));
  const filterOptions = createMemo(
    () =>
      props.data.filterOptions ?? {
        agent: [],
        channel: [],
        provider: [],
        model: [],
        tool: [],
      },
  );
  const queryTerms = createMemo(() => extractQueryTerms(props.filters.queryDraft));
  const querySuggestions = createMemo(() =>
    buildQuerySuggestions(props.filters.queryDraft, queryTerms(), filterOptions()),
  );
  const hasDraftQuery = () => props.filters.queryDraft.trim().length > 0;
  const hasQuery = () => props.filters.query.trim().length > 0;
  const queryWarnings = () =>
    (props.data.overview?.queryWarnings ?? []).filter(
      (warning) => warning !== props.data.partialNotice,
    );
  const primarySelectedEntry = createMemo(() =>
    props.filters.selectedSessions.length === 1 && props.data.overview?.selectedRowCount !== 0
      ? (props.data.selectedSession ??
        props.data.sessions.find((session) => session.key === props.filters.selectedSessions[0]))
      : null,
  );
  const totalSessions = () =>
    props.data.overview?.unfilteredSessionCount ??
    props.data.aggregates?.sessionCount ??
    props.data.sessions.length;
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
  const displaySessionCount = createMemo(
    () =>
      props.data.overview?.selectedSessionCount ??
      props.data.overview?.total ??
      props.data.aggregates?.sessionCount ??
      props.data.sessions.length,
  );
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
  const exportSessionCount = () => props.data.overview?.selectedRowCount ?? displaySessionCount();
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
  const isEmpty = () => overview().isEmpty && !loading() && !props.data.error;
  const showAnalytics = () => overview().hasOverviewData && !isEmpty();
  const datePresets = [
    { labelKey: "usage.presets.today", days: 1 },
    { labelKey: "usage.presets.last7d", days: 7 },
    { labelKey: "usage.presets.last30d", days: 30 },
    { labelKey: "usage.presets.last90d", days: 90 },
    { labelKey: "usage.presets.last1y", days: 365 },
  ];
  const presetRange = (days: number) => {
    const end = new Date();
    const start = new Date(end);
    if (props.filters.timeZone === "utc") {
      start.setUTCDate(start.getUTCDate() - (days - 1));
    } else {
      start.setDate(start.getDate() - (days - 1));
    }
    return {
      start: formatIsoDate(start, props.filters.timeZone),
      end: formatIsoDate(end, props.filters.timeZone),
    };
  };

  const applyPreset = (days: number) => {
    const range = presetRange(days);
    props.callbacks.filters.onDatesChange({ startDate: range.start });
    props.callbacks.filters.onDatesChange({ endDate: range.end });
  };
  const selectedPreset = createMemo(() => {
    if (props.filters.startDate === "1970-01-01") {
      return "all";
    }
    const match = datePresets.find((preset) => {
      const range = presetRange(preset.days);
      return props.filters.startDate === range.start && props.filters.endDate === range.end;
    });
    return match ? String(match.days) : "";
  });
  const applyPresetKey = (key: string) =>
    key === "all" ? applyAllRange() : applyPreset(Number(key));
  const applyAllRange = () => {
    props.callbacks.filters.onDatesChange({ startDate: "1970-01-01" });
    props.callbacks.filters.onDatesChange({
      endDate: formatIsoDate(new Date(), props.filters.timeZone),
    });
  };
  return (
    <SettingsPage wide>
      <div class="usage-page">
        <section class="usage-header-section">
          <div class={["usage-header", { pinned: props.display.headerPinned }]}>
            <div class="usage-toolbar">
              <div class="usage-controls">
                <SettingsSegmented
                  mode="buttons"
                  class="usage-presets"
                  ariaLabel={t("usage.filters.rangeTitle")}
                  value={selectedPreset()}
                  onChange={applyPresetKey}
                  onReselect={applyPresetKey}
                  options={[
                    ...datePresets.map((preset) => ({
                      value: String(preset.days),
                      label: t(preset.labelKey),
                    })),
                    { value: "all", label: t("usage.presets.all") },
                  ]}
                />
                <div class="usage-date-range">
                  <DateInput
                    value={props.filters.startDate}
                    label={t("usage.filters.startDate")}
                    onChange={(startDate) => props.callbacks.filters.onDatesChange({ startDate })}
                  />
                  <span class="usage-separator">{t("usage.filters.to")}</span>
                  <DateInput
                    value={props.filters.endDate}
                    label={t("usage.filters.endDate")}
                    onChange={(endDate) => props.callbacks.filters.onDatesChange({ endDate })}
                  />
                </div>
                <SettingsSelect
                  class="usage-select"
                  title={t("usage.filters.timeZone")}
                  aria-label={t("usage.filters.timeZone")}
                  value={props.filters.timeZone}
                  options={[
                    { value: "local", label: t("usage.filters.timeZoneLocal") },
                    { value: "utc", label: t("usage.filters.timeZoneUtc") },
                  ]}
                  onChange={(event) => {
                    const timeZone = event.currentTarget.value;
                    if (timeZone === "local" || timeZone === "utc") {
                      props.callbacks.filters.onScopeChange({ timeZone });
                    }
                  }}
                />
              </div>
              <div class="usage-view-options">
                <UsageCreatorFilter
                  options={props.data.creatorOptions}
                  selectedKey={props.filters.creatorKey}
                  onSelect={(creatorKey) => props.callbacks.filters.onScopeChange({ creatorKey })}
                />
                <SettingsSegmented
                  mode="buttons"
                  value={props.filters.scope}
                  onChange={(scope) => props.callbacks.filters.onScopeChange({ scope })}
                  onReselect={(scope) => props.callbacks.filters.onScopeChange({ scope })}
                  options={[
                    {
                      value: "instance",
                      label: t("usage.scope.instance"),
                      title: t("usage.scope.instanceHint"),
                    },
                    {
                      value: "family",
                      label: t("usage.scope.family"),
                      title: t("usage.scope.familyHint"),
                    },
                  ]}
                />
                <SettingsSegmented
                  mode="buttons"
                  value={props.display.chartMode === "tokens" ? "tokens" : "cost"}
                  onChange={(chartMode) => props.callbacks.display.onChange({ chartMode })}
                  onReselect={(chartMode) => props.callbacks.display.onChange({ chartMode })}
                  options={[
                    { value: "tokens", label: t("usage.metrics.tokens") },
                    { value: "cost", label: t("usage.metrics.cost") },
                  ]}
                />
                <button
                  class="btn btn--sm btn--icon"
                  aria-label={t("common.refresh")}
                  title={t("common.refresh")}
                  onClick={() => void props.callbacks.filters.onRefresh()}
                  disabled={loading()}
                >
                  <Icon name="refresh" />
                </button>
              </div>
            </div>

            {/* Carapace summary strip: fixed cells, so placeholders and loaded totals share one layout. */}
            <div class="usage-summary-strip">
              <For each={metricBadges()}>
                {([value, label]) => (
                  <div class="usage-metric-badge">
                    <strong>{value}</strong> <small>{label}</small>
                  </div>
                )}
              </For>
              <div class="usage-summary-strip__actions">
                {/* One fixed slot: the incomplete-data chip, laid out even when hidden so nothing reflows. */}
                <span class="usage-summary-strip__status">
                  <openclaw-tooltip
                    open-on-click
                    class={[
                      "usage-partial-notice",
                      { "usage-partial-notice--off": !partialNotice() },
                    ]}
                    role="note"
                    aria-hidden={partialNotice() ? undefined : "true"}
                  >
                    <button
                      type="button"
                      class="usage-partial-notice__chip"
                      tabindex={partialNotice() ? undefined : -1}
                    >
                      {t("usage.partialShort")}
                    </button>
                    <span slot="content">{partialNotice()}</span>
                  </openclaw-tooltip>
                </span>
                <button
                  class={[
                    "btn btn--sm btn--icon usage-pin-btn",
                    { active: props.display.headerPinned },
                  ]}
                  aria-label={
                    props.display.headerPinned ? t("usage.filters.pinned") : t("usage.filters.pin")
                  }
                  aria-pressed={props.display.headerPinned ? "true" : "false"}
                  title={
                    props.display.headerPinned ? t("usage.filters.pinned") : t("usage.filters.pin")
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
                  items={[
                    {
                      id: "sessions-csv",
                      label: t("usage.export.sessionsCsv"),
                      disabled: props.data.exporting || exportSessionCount() === 0,
                    },
                    {
                      id: "daily-csv",
                      label: t("usage.export.dailyCsv"),
                      disabled: props.data.exporting || props.data.costDaily.length === 0,
                    },
                    {
                      id: "json",
                      label: t("usage.export.json"),
                      disabled:
                        props.data.exporting ||
                        loading() ||
                        (exportSessionCount() === 0 && props.data.costDaily.length === 0),
                    },
                  ]}
                  onSelect={(item) => {
                    switch (item.id) {
                      case "sessions-csv":
                      case "daily-csv":
                        props.callbacks.display.onExportCsv(item.id);
                        break;
                      case "json":
                        props.callbacks.display.onExportJson();
                        break;
                    }
                  }}
                />
              </div>
            </div>
            {renderFilterChips(props.data.overview?.selectedRows ?? props.data.sessions, props)}

            <div class="usage-query-section">
              <div class="usage-query-bar">
                <input
                  class="usage-query-input"
                  type="text"
                  value={props.filters.queryDraft}
                  aria-label={t("usage.query.placeholder")}
                  placeholder={t("usage.query.placeholder")}
                  onInput={(event) =>
                    props.callbacks.filters.onQueryDraftChange(event.currentTarget.value)
                  }
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      props.callbacks.filters.onApplyQuery();
                    }
                  }}
                />
                <div class="usage-query-actions">
                  <button
                    class="btn btn--sm"
                    onClick={() => props.callbacks.filters.onApplyQuery()}
                    disabled={loading() || (!hasDraftQuery() && !hasQuery())}
                  >
                    {t("usage.query.apply")}
                  </button>
                  {hasDraftQuery() || hasQuery() ? (
                    <button
                      class="btn btn--sm"
                      onClick={() => props.callbacks.filters.onClearQuery()}
                    >
                      {t("usage.filters.clear")}
                    </button>
                  ) : undefined}
                </div>
              </div>
              <div class="usage-filter-row">
                <For each={["channel", "provider", "model", "tool"] as const}>
                  {(filterKey) => (
                    <UsageQueryFilter
                      filterKey={filterKey}
                      label={t(`usage.filters.${filterKey}`)}
                      options={filterOptions()[filterKey]}
                      queryDraft={props.filters.queryDraft}
                      queryTerms={queryTerms()}
                      onQueryDraftChange={props.callbacks.filters.onQueryDraftChange}
                    />
                  )}
                </For>
                <span class="usage-query-hint">{t("usage.query.tip")}</span>
                {/* Last in the row, so the count arriving with data moves nothing. */}
                <span class="usage-query-hint usage-query-count">
                  {!overview().hasOverviewData
                    ? undefined
                    : hasQuery()
                      ? t("usage.query.matching", {
                          shown: (
                            props.data.sessionPage?.total ??
                            props.data.overview?.total ??
                            props.data.sessions.length
                          ).toLocaleString(),
                          total: totalSessions().toLocaleString(),
                        })
                      : t("usage.query.inRange", { total: totalSessions().toLocaleString() })}
                </span>
              </div>
              {queryTerms().length > 0 ? (
                <div class="usage-query-chips">
                  <For each={queryTerms()}>
                    {(term) => {
                      const label = term.raw;
                      const removeLabel = () => `${t("usage.filters.remove")}: ${label}`;
                      return (
                        <span class="usage-query-chip">
                          {label}
                          <openclaw-tooltip prop:content={removeLabel()}>
                            <button
                              aria-label={removeLabel()}
                              onClick={() =>
                                props.callbacks.filters.onQueryDraftChange(
                                  removeQueryToken(props.filters.queryDraft, label),
                                )
                              }
                            >
                              <Icon name="x" />
                            </button>
                          </openclaw-tooltip>
                        </span>
                      );
                    }}
                  </For>
                </div>
              ) : undefined}
              {querySuggestions().length > 0 ? (
                <div class="usage-query-suggestions">
                  <For each={querySuggestions()}>
                    {(suggestion) => (
                      <button
                        class="usage-query-suggestion"
                        onClick={() =>
                          props.callbacks.filters.onQueryDraftChange(
                            applySuggestionToQuery(props.filters.queryDraft, suggestion.value),
                          )
                        }
                      >
                        {suggestion.label}
                      </button>
                    )}
                  </For>
                </div>
              ) : undefined}
              {queryWarnings().length > 0 ? (
                <div class="callout warning usage-callout usage-callout--tight">
                  {queryWarnings().join(" · ")}
                </div>
              ) : undefined}
            </div>

            <UsageReadStatus read={props.read}>
              {() =>
                props.data.error ? (
                  <div class="callout danger usage-callout">{props.data.error}</div>
                ) : undefined
              }
            </UsageReadStatus>
            {props.data.cacheRefresh === "failed" ? (
              <div
                class="callout warning usage-callout usage-cache-warning"
                role="status"
                aria-live="polite"
              >
                {t("usage.cacheStatus.paused")}
              </div>
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
              {
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
              }
              <Show when={showAnalytics() && displayTotals()}>
                {(totals) => (
                  <CostBreakdownCompact totals={totals()} mode={props.display.chartMode} />
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={showAnalytics()}>
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
        <Show when={showAnalytics()}>
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
