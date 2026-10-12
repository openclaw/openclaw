import { For, Show, createMemo } from "solid-js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { renderProviderUsageDetails } from "../../components/solid/provider-usage.tsx";
import {
  SettingsSection,
  SettingsPage,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../../styles/usage.css";
import { resolveUsageOverviewState } from "./cache-status.ts";
import type { ProviderUsageSummary } from "./data-types.ts";
import { formatIsoDate } from "./helpers.ts";
import { UsageMosaic } from "./metrics-view.tsx";
import { buildPeakErrorHours, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageEmptyState, renderUsageLoadingStatus } from "./page-shell.tsx";
import { buildQuerySuggestions } from "./query.ts";
import type { UsageProps } from "./types.ts";
import { DailyChartCompact, CostBreakdownCompact } from "./view-chart.tsx";
import { UsageCreatorFilter, UsageCreators } from "./view-creators.tsx";
import { SessionDetailPanel } from "./view-details.tsx";
import { renderUsageHeatmap } from "./view-heatmap.tsx";
import { renderCostWindowComparison, renderFilterChips, UsageInsights } from "./view-overview.tsx";
import { UsageQuerySection } from "./view-query-section.tsx";
import { SessionsCard } from "./view-sessions-card.tsx";

registerEnglishCatalog(registerUsageEnglish);

type ProviderUsageSnapshot = ProviderUsageSummary["providers"][number];

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

function renderProviderUsage(
  providers: ProviderUsageSnapshot[],
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
                {renderProviderUsageDetails(provider)}
              </article>
            )}
          </For>
        </div>
      </div>
    </SettingsSection>
  );
}

export function renderUsage(props: UsageProps) {
  const state = createMemo(() => {
    const data = props.data;
    const filters = props.filters;
    const display = props.display;
    const detail = props.detail;
    const callbacks = props.callbacks;
    const filterActions = callbacks.filters;
    const displayActions = callbacks.display;
    const detailActions = callbacks.details;

    const { hasOverviewData, loadingOverview } = resolveUsageOverviewState(data);
    const isTokenMode = display.chartMode === "tokens";
    const hasQuery = filters.query.trim().length > 0;
    const hasDraftQuery = filters.queryDraft.trim().length > 0;
    const overview = data.overview;
    const filteredSessions = data.sessions;
    const queryWarnings = overview?.queryWarnings ?? [];
    const filterOptions = overview?.filterOptions ?? {
      agent: [],
      channel: [],
      provider: [],
      model: [],
      tool: [],
    };
    const querySuggestions = buildQuerySuggestions(filters.queryDraft, filterOptions);
    const queryTerms = extractQueryTerms(filters.queryDraft);
    const primarySelectedEntry =
      filters.selectedSessions.length === 1 && overview?.selectedRowCount !== 0
        ? (data.selectedSession ??
          data.sessions.find((session) => session.key === filters.selectedSessions[0]))
        : null;
    const filteredDaily = data.costDaily;
    const displayTotals = hasOverviewData ? data.totals : null;
    const totalSessions =
      overview?.unfilteredSessionCount ?? data.aggregates?.sessionCount ?? data.sessions.length;
    const activeAggregates = data.aggregates ?? {
      messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      daily: [],
    };
    const displaySessionCount =
      overview?.selectedSessionCount ??
      overview?.total ??
      data.aggregates?.sessionCount ??
      data.sessions.length;
    const exportSessionCount = overview?.selectedRowCount ?? displaySessionCount;
    const insightTotals = displayTotals;
    const insightAggregates = activeAggregates;
    const costWindowComparison = renderCostWindowComparison(
      data.costDaily,
      filters.startDate,
      filters.endDate,
      filters.timeZone,
    );
    const durationMs = overview?.durationMs ?? 0;
    const durationCount = overview?.durationCount ?? 0;
    const insightStats = {
      durationCount,
      avgDurationMs: durationCount ? durationMs / durationCount : 0,
      throughputTokensPerMin:
        displayTotals && durationMs > 0
          ? displayTotals.totalTokens / (durationMs / 60000)
          : undefined,
      throughputCostPerMin:
        displayTotals && durationMs > 0
          ? displayTotals.totalCost / (durationMs / 60000)
          : undefined,
      errorRate: activeAggregates.messages.total
        ? activeAggregates.messages.errors / activeAggregates.messages.total
        : 0,
    };
    // The gateway always returns a totals object (all-zero when idle), so key
    // the empty state off content — and never render it under an error callout,
    // where "no usage data yet" would misexplain the failure.
    const isEmpty =
      data.cacheRefresh === "complete" &&
      data.totals !== null &&
      !data.loading &&
      !data.error &&
      data.sessions.length === 0 &&
      (overview?.unfilteredSessionCount ?? 0) === 0 &&
      (data.totals?.totalTokens ?? 0) === 0;
    const hasMissingCost = (displayTotals?.missingCostEntries ?? 0) > 0;
    const datePresets = [
      { label: t("usage.presets.today"), days: 1 },
      { label: t("usage.presets.last7d"), days: 7 },
      { label: t("usage.presets.last30d"), days: 30 },
      { label: t("usage.presets.last90d"), days: 90 },
      { label: t("usage.presets.last1y"), days: 365 },
    ];
    const presetRange = (days: number) => {
      const end = new Date();
      const start = new Date(end);
      if (filters.timeZone === "utc") {
        start.setUTCDate(start.getUTCDate() - (days - 1));
      } else {
        start.setDate(start.getDate() - (days - 1));
      }
      return {
        start: formatIsoDate(start, filters.timeZone),
        end: formatIsoDate(end, filters.timeZone),
      };
    };
    const isPresetSelected = (days: number) => {
      const range = presetRange(days);
      return filters.startDate === range.start && filters.endDate === range.end;
    };
    const applyPreset = (days: number) => {
      const range = presetRange(days);
      filterActions.onDatesChange({ startDate: range.start });
      filterActions.onDatesChange({ endDate: range.end });
    };
    const applyAllRange = () => {
      filterActions.onDatesChange({ startDate: "1970-01-01" });
      filterActions.onDatesChange({ endDate: formatIsoDate(new Date(), filters.timeZone) });
    };

    return {
      activeAggregates,
      applyAllRange,
      applyPreset,
      costWindowComparison,
      data,
      datePresets,
      detail,
      detailActions,
      display,
      displayActions,
      displaySessionCount,
      exportSessionCount,
      displayTotals,
      filterActions,
      filterOptions,
      filteredDaily,
      filteredSessions,
      filters,
      hasDraftQuery,
      hasMissingCost,
      hasOverviewData,
      hasQuery,
      insightAggregates,
      insightStats,
      insightTotals,
      isEmpty,
      isPresetSelected,
      isTokenMode,
      loadingOverview,
      primarySelectedEntry,
      querySuggestions,
      queryTerms,
      queryWarnings,
      totalSessions,
    };
  });
  return (
    <SettingsPage wide>
      <div class="usage-page">
        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">{t("usage.filters.rangeTitle")}</h2>
            <div class="settings-section__actions">
              {state().loadingOverview
                ? renderUsageLoadingStatus(t("usage.loading.badge"))
                : undefined}
              {state().isEmpty ? (
                <>
                  {" "}
                  <span class="usage-query-hint">{t("usage.empty.hint")}</span>{" "}
                </>
              ) : undefined}
            </div>
          </div>
          <div
            class={[
              "settings-group usage-panel usage-header",
              { pinned: state().display.headerPinned },
            ]}
          >
            <div class="usage-header-row">
              <div class="usage-controls">
                {renderFilterChips(state().data.sessions, props)}
                <div class="usage-presets">
                  <For each={state().datePresets} keyed={(preset) => preset.days}>
                    {(preset) => (
                      <button
                        class={["btn btn--sm", { active: state().isPresetSelected(preset().days) }]}
                        aria-pressed={state().isPresetSelected(preset().days) ? "true" : "false"}
                        onClick={() => state().applyPreset(preset().days)}
                      >
                        {preset().label}
                      </button>
                    )}
                  </For>
                  <button
                    class={["btn btn--sm", { active: state().filters.startDate === "1970-01-01" }]}
                    aria-pressed={state().filters.startDate === "1970-01-01" ? "true" : "false"}
                    onClick={() => state().applyAllRange()}
                  >
                    {t("usage.presets.all")}
                  </button>
                </div>
                <div class="usage-date-range">
                  <DateInput
                    value={state().filters.startDate}
                    label={t("usage.filters.startDate")}
                    onChange={(startDate) => state().filterActions.onDatesChange({ startDate })}
                  />
                  <span class="usage-separator">{t("usage.filters.to")}</span>
                  <DateInput
                    value={state().filters.endDate}
                    label={t("usage.filters.endDate")}
                    onChange={(endDate) => state().filterActions.onDatesChange({ endDate })}
                  />
                </div>
                <select
                  class="usage-select"
                  title={t("usage.filters.timeZone")}
                  aria-label={t("usage.filters.timeZone")}
                  value={state().filters.timeZone}
                  onChange={(event) => {
                    const timeZone = event.currentTarget.value;
                    if (timeZone === "local" || timeZone === "utc") {
                      state().filterActions.onScopeChange({ timeZone });
                    }
                  }}
                >
                  <option value="local">{t("usage.filters.timeZoneLocal")}</option>
                  <option value="utc">{t("usage.filters.timeZoneUtc")}</option>
                </select>
              </div>
              <div class="usage-view-options">
                <UsageCreatorFilter
                  options={state().data.creatorOptions}
                  selectedKey={state().filters.creatorKey}
                  onSelect={(creatorKey) => state().filterActions.onScopeChange({ creatorKey })}
                />
                <SettingsSegmented
                  mode="buttons"
                  variant="accent"
                  value={state().filters.scope}
                  onChange={(scope) => state().filterActions.onScopeChange({ scope })}
                  onReselect={(scope) => state().filterActions.onScopeChange({ scope })}
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
                  variant="accent"
                  value={state().isTokenMode ? "tokens" : "cost"}
                  onChange={(chartMode) => state().displayActions.onChange({ chartMode })}
                  onReselect={(chartMode) => state().displayActions.onChange({ chartMode })}
                  options={[
                    { value: "tokens", label: t("usage.metrics.tokens") },
                    { value: "cost", label: t("usage.metrics.cost") },
                  ]}
                />
                <button
                  class="btn btn--sm primary"
                  onClick={() => state().filterActions.onRefresh()}
                  disabled={state().data.loading}
                >
                  {t("common.refresh")}
                </button>
              </div>
            </div>

            <div class="usage-header-row">
              <div class="usage-header-metrics">
                <Show when={state().displayTotals}>
                  {(totals) => (
                    <For
                      each={[
                        [formatUsageTokens(totals().totalTokens), t("usage.metrics.tokens")],
                        [formatUsageCost(totals().totalCost), t("usage.metrics.cost")],
                        [
                          state().displaySessionCount,
                          t(
                            state().displaySessionCount === 1
                              ? "usage.metrics.session"
                              : "usage.metrics.sessions",
                          ),
                        ],
                      ]}
                    >
                      {([value, label]) => (
                        <span class="usage-metric-badge">
                          <strong>{value}</strong> {label}
                        </span>
                      )}
                    </For>
                  )}
                </Show>
                <button
                  class={["btn btn--sm usage-pin-btn", { active: state().display.headerPinned }]}
                  onClick={() => state().filterActions.onToggleHeaderPinned()}
                >
                  {state().display.headerPinned
                    ? t("usage.filters.pinned")
                    : t("usage.filters.pin")}
                </button>
                <wa-dropdown
                  class="usage-export-menu"
                  placement="bottom-end"
                  onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
                    const value = event.detail.item.value;
                    switch (value) {
                      case "sessions-csv":
                      case "daily-csv":
                        state().displayActions.onExportCsv(value);
                        break;
                      case "json":
                        state().displayActions.onExportJson();
                        break;
                      case undefined:
                        break;
                    }
                  }}
                >
                  <button
                    slot="trigger"
                    type="button"
                    class="btn btn--sm"
                    aria-busy={state().data.exporting ? "true" : "false"}
                  >
                    {state().data.exporting ? t("common.loading") : t("usage.export.label")} ▾
                  </button>
                  <wa-dropdown-item
                    value="sessions-csv"
                    disabled={state().data.exporting || state().exportSessionCount === 0}
                  >
                    {t("usage.export.sessionsCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item value="daily-csv" disabled={state().filteredDaily.length === 0}>
                    {t("usage.export.dailyCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item
                    value="json"
                    disabled={
                      state().data.exporting ||
                      state().data.loading ||
                      (state().exportSessionCount === 0 && state().filteredDaily.length === 0)
                    }
                  >
                    {t("usage.export.json")}
                  </wa-dropdown-item>
                </wa-dropdown>
              </div>
            </div>

            <UsageQuerySection
              filters={state().filters}
              actions={state().filterActions}
              loading={state().data.loading}
              hasDraftQuery={state().hasDraftQuery}
              hasQuery={state().hasQuery}
              hasOverviewData={state().hasOverviewData}
              matchingSessions={
                state().data.sessionPage?.total ??
                state().data.overview?.total ??
                state().filteredSessions.length
              }
              totalSessions={state().totalSessions}
              filterOptions={state().filterOptions}
              queryTerms={state().queryTerms}
              querySuggestions={state().querySuggestions}
              queryWarnings={state().queryWarnings}
            />

            {state().data.error ? (
              <div class="callout danger usage-callout">{state().data.error}</div>
            ) : undefined}
            {state().data.cacheRefresh !== "complete" ? (
              <div
                class={[
                  "callout usage-callout usage-cache-warning",
                  { warning: state().data.cacheRefresh === "failed" },
                ]}
                role="status"
                aria-live="polite"
              >
                {t(
                  state().data.cacheRefresh === "failed"
                    ? "usage.cacheStatus.paused"
                    : "usage.cacheStatus.warning",
                )}
              </div>
            ) : undefined}
          </div>
        </section>

        {!state().hasOverviewData ? (
          state().loadingOverview ? (
            <div class="usage-panel usage-loading-card">
              <div class="usage-loading-grid">
                <div class="skeleton usage-skeleton-block usage-skeleton-block--tall" />
                <div class="skeleton usage-skeleton-block" />
                <div class="skeleton usage-skeleton-block" />
              </div>
            </div>
          ) : undefined
        ) : state().isEmpty ? (
          renderUsageEmptyState(state().filterActions.onRefresh)
        ) : (
          <>
            <div class="settings-group usage-panel usage-left-card usage-trend-section">
              {
                <DailyChartCompact
                  dailyEntries={state().filteredDaily}
                  selectedDays={state().filters.selectedDays}
                  chartMode={state().display.chartMode}
                  dailyChartMode={state().display.dailyChartMode}
                  onDailyChartModeChange={(dailyChartMode) =>
                    state().displayActions.onChange({ dailyChartMode })
                  }
                  onSelectDay={state().filterActions.onSelectDay}
                  range={{
                    startDate: state().filters.startDate,
                    endDate: state().filters.endDate,
                    complete: state().data.cacheRefresh === "complete",
                  }}
                />
              }
              <Show when={state().displayTotals}>
                {(totals) => (
                  <CostBreakdownCompact totals={totals()} mode={state().display.chartMode} />
                )}
              </Show>
            </div>
            <UsageCreators
              groups={state().activeAggregates.byCreator ?? []}
              selectedKey={state().filters.creatorKey}
              mode={state().display.chartMode}
              onSelect={(creatorKey) => state().filterActions.onScopeChange({ creatorKey })}
            />
            <UsageInsights
              totals={state().insightTotals}
              aggregates={state().insightAggregates}
              stats={state().insightStats}
              showCostHint={state().hasMissingCost}
              showCostShares={state().filters.selectedDays.length === 0}
              errorHours={buildPeakErrorHours(
                state().data.overview?.hourlyMessages ?? [],
                state().data.overview?.hourlyErrors ?? [],
              )}
              sessionCount={state().displaySessionCount}
              totalSessions={state().totalSessions}
            />
            {state().costWindowComparison}
            {renderUsageHeatmap(
              state().filteredDaily,
              state().filters.startDate,
              state().filters.endDate,
            )}
            {
              <UsageMosaic
                overview={state().data.overview}
                timeZone={state().filters.timeZone}
                selectedHours={state().filters.selectedHours}
                onSelectHour={state().filterActions.onSelectHour}
              />
            }

            <div class="usage-grid">
              <div class="usage-grid-column">
                <SessionsCard
                  sessions={state().filteredSessions}
                  usage={props}
                  totalSessions={state().data.overview?.total ?? state().totalSessions}
                  overview={state().data.sessionPage ?? state().data.overview}
                  loading={state().data.loading}
                />
              </div>
              <Show when={state().primarySelectedEntry}>
                {(selectedSession) => (
                  <div class="usage-grid-column">
                    <SessionDetailPanel
                      session={selectedSession()}
                      detail={state().detail}
                      callbacks={state().detailActions}
                      range={state().filters}
                      contextExpanded={state().display.contextExpanded}
                      onClose={() => state().filterActions.onClearSessions()}
                    />
                  </div>
                )}
              </Show>
            </div>
          </>
        )}
        {renderProviderUsage(
          state().data.providerUsage,
          state().data.providerUsageUnavailable,
          state().data.providerUsageStalled,
        )}
      </div>
    </SettingsPage>
  );
}
