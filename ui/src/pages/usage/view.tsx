import { For, Show, createMemo } from "solid-js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import {
  SettingsSection,
  SettingsPage,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { resolveUsageOverviewState } from "./cache-status.ts";
import "../../styles/usage.css";
import type { ProviderUsageSummary } from "./data-types.ts";
import { extractQueryTerms, filterSessionsByQuery, formatIsoDate } from "./helpers.ts";
import { UsageMosaic } from "./metrics-view.tsx";
import {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageInsightStats,
  formatUsageCost,
  formatUsageTokens,
  sessionTouchesSelectedHours,
} from "./metrics.ts";
import { renderUsageEmptyState, renderUsageLoadingStatus } from "./page-shell.tsx";
import {
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  buildUsageFilterOptions,
} from "./query.ts";
import type { UsageProps, UsageSessionEntry, UsageTotals } from "./types.ts";
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
                <LitContent render={() => renderProviderUsageDetails(provider)} />
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
    const filterActions = props.callbacks.filters;

    const { hasOverviewData, loadingOverview } = resolveUsageOverviewState(data);
    const isTokenMode = display.chartMode === "tokens";
    const hasQuery = filters.query.trim().length > 0;
    const hasDraftQuery = filters.queryDraft.trim().length > 0;
    const selectedDaySet = new Set(filters.selectedDays);
    const selectedSessionSet = new Set(filters.selectedSessions);

    const sortedSessions = data.sessions.toSorted((a, b) => {
      const valA = isTokenMode ? (a.usage?.totalTokens ?? 0) : (a.usage?.totalCost ?? 0);
      const valB = isTokenMode ? (b.usage?.totalTokens ?? 0) : (b.usage?.totalCost ?? 0);
      return valB - valA;
    });

    const hourFilteredSessions =
      filters.selectedHours.length > 0
        ? sortedSessions.filter((session) =>
            sessionTouchesSelectedHours(session, filters.selectedHours, filters.timeZone),
          )
        : sortedSessions;
    const queryResult = filterSessionsByQuery(hourFilteredSessions, filters.query);
    const matchesSelectedDays = (session: UsageSessionEntry) => {
      if (selectedDaySet.size === 0) {
        return true;
      }
      if (session.usage?.activityDates?.length) {
        return session.usage.activityDates.some((date) => selectedDaySet.has(date));
      }
      return Boolean(
        session.updatedAt &&
        selectedDaySet.has(formatIsoDate(new Date(session.updatedAt), filters.timeZone)),
      );
    };
    const filteredSessions = queryResult.sessions.filter(matchesSelectedDays);
    const queryWarnings = queryResult.warnings;
    const filterOptions = buildUsageFilterOptions(sortedSessions, data.aggregates);
    const querySuggestions = buildQuerySuggestions(filters.queryDraft, filterOptions);
    const queryTerms = extractQueryTerms(filters.queryDraft);

    const primarySelectedEntry =
      filters.selectedSessions.length === 1
        ? data.sessions.find((s) => s.key === filters.selectedSessions[0])
        : null;

    const scopedSessions = selectedSessionSet.size
      ? queryResult.sessions.filter((session) => selectedSessionSet.has(session.key))
      : queryResult.sessions;
    const aggregateSessions = scopedSessions.filter(matchesSelectedDays);
    const hasSessionFilters =
      selectedSessionSet.size > 0 || hasQuery || filters.selectedHours.length > 0;
    const hasAggregateFilters = hasSessionFilters || selectedDaySet.size > 0;
    const computeTotals = (sources: Iterable<UsageTotals | null | undefined>): UsageTotals => {
      const totals = createEmptyCostUsageTotals();
      for (const source of sources) {
        if (source) {
          addCostUsageTotals(totals, source);
        }
      }
      return totals;
    };
    // Keep global daily totals when no row scope is active: the visible session page can be capped.
    let filteredDaily = data.costDaily;
    if (hasSessionFilters) {
      const days = new Map<string, UsageTotals>();
      for (const session of scopedSessions) {
        for (const day of session.usage?.dailyBreakdown ?? []) {
          const totals = days.get(day.date) ?? createEmptyCostUsageTotals();
          addCostUsageTotals(totals, day);
          days.set(day.date, totals);
        }
      }
      filteredDaily = Array.from(days, ([date, totals]) => ({ date, ...totals })).toSorted((a, b) =>
        a.date.localeCompare(b.date),
      );
    }
    const displayTotals = !hasOverviewData
      ? null
      : selectedDaySet.size
        ? computeTotals(filteredDaily.filter((day) => selectedDaySet.has(day.date)))
        : hasSessionFilters
          ? computeTotals(aggregateSessions.map((session) => session.usage))
          : data.totals;
    const totalSessions = data.aggregates?.sessionCount ?? sortedSessions.length;
    const activeAggregates = hasAggregateFilters
      ? buildAggregatesFromSessions(aggregateSessions)
      : buildAggregatesFromSessions([], data.aggregates);
    const serverCreators = !hasSessionFilters ? data.aggregates?.byCreator : undefined;
    if (selectedDaySet.size > 0) {
      activeAggregates.byCreator = (serverCreators ?? activeAggregates.byCreator ?? []).flatMap(
        (creator) => {
          const daily = creator.daily.filter((day) => selectedDaySet.has(day.date));
          const sessionActivity = creator.sessionActivity.flatMap((activity) => {
            const dates = activity.dates.filter((date) => selectedDaySet.has(date));
            return dates.length ? [{ dates, sessionCount: activity.sessionCount }] : [];
          });
          const sessionCount = sessionActivity.reduce(
            (sum, activity) => sum + activity.sessionCount,
            0,
          );
          const totals = computeTotals(daily);
          return sessionCount || totals.totalTokens || totals.totalCost
            ? [{ ...creator, totals, sessionCount, daily, sessionActivity }]
            : [];
        },
      );
    }
    const displaySessionCount =
      selectedDaySet.size > 0 && serverCreators
        ? (activeAggregates.byCreator ?? []).reduce((sum, creator) => sum + creator.sessionCount, 0)
        : hasAggregateFilters
          ? aggregateSessions.length
          : (data.aggregates?.sessionCount ?? aggregateSessions.length);
    if (selectedDaySet.size > 0 && serverCreators) {
      activeAggregates.sessionCount = displaySessionCount;
    }
    const insightsUseVisiblePage = data.sessionsLimitReached && !hasAggregateFilters;
    const insightTotals = insightsUseVisiblePage
      ? computeTotals(aggregateSessions.map((session) => session.usage))
      : displayTotals;
    const insightAggregates = insightsUseVisiblePage
      ? buildAggregatesFromSessions(aggregateSessions)
      : activeAggregates;
    // Cost windows use range-wide daily totals; filtered pages need exact scoped data.
    const costWindowComparison = hasAggregateFilters
      ? undefined
      : renderCostWindowComparison(
          data.costDaily,
          filters.startDate,
          filters.endDate,
          filters.timeZone,
        );

    const insightStats = buildUsageInsightStats(
      aggregateSessions,
      insightTotals,
      insightAggregates,
    );
    // The gateway always returns a totals object (all-zero when idle), so key
    // the empty state off content — and never render it under an error callout,
    // where "no usage data yet" would misexplain the failure.
    const isEmpty =
      data.cacheRefresh === "complete" &&
      data.totals !== null &&
      !data.loading &&
      !data.error &&
      data.sessions.length === 0 &&
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
    const exportStamp = formatIsoDate(new Date());

    return {
      activeAggregates,
      aggregateSessions,
      applyAllRange,
      applyPreset,
      costWindowComparison,
      datePresets,
      displaySessionCount,
      displayTotals,
      exportStamp,
      filterOptions,
      filteredDaily,
      filteredSessions,
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
              { pinned: props.display.headerPinned },
            ]}
          >
            <div class="usage-header-row">
              <div class="usage-controls">
                {renderFilterChips(props.data.sessions, props)}
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
                    class={["btn btn--sm", { active: props.filters.startDate === "1970-01-01" }]}
                    aria-pressed={props.filters.startDate === "1970-01-01" ? "true" : "false"}
                    onClick={() => state().applyAllRange()}
                  >
                    {t("usage.presets.all")}
                  </button>
                </div>
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
                <select
                  class="usage-select"
                  title={t("usage.filters.timeZone")}
                  aria-label={t("usage.filters.timeZone")}
                  value={props.filters.timeZone}
                  onChange={(event) => {
                    const timeZone = event.currentTarget.value;
                    if (timeZone === "local" || timeZone === "utc") {
                      props.callbacks.filters.onScopeChange({ timeZone });
                    }
                  }}
                >
                  <option value="local">{t("usage.filters.timeZoneLocal")}</option>
                  <option value="utc">{t("usage.filters.timeZoneUtc")}</option>
                </select>
              </div>
              <div class="usage-view-options">
                <UsageCreatorFilter
                  options={props.data.creatorOptions}
                  selectedKey={props.filters.creatorKey}
                  onSelect={(creatorKey) => props.callbacks.filters.onScopeChange({ creatorKey })}
                />
                <SettingsSegmented
                  mode="buttons"
                  variant="accent"
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
                  variant="accent"
                  value={state().isTokenMode ? "tokens" : "cost"}
                  onChange={(chartMode) => props.callbacks.display.onChange({ chartMode })}
                  onReselect={(chartMode) => props.callbacks.display.onChange({ chartMode })}
                  options={[
                    { value: "tokens", label: t("usage.metrics.tokens") },
                    { value: "cost", label: t("usage.metrics.cost") },
                  ]}
                />
                <button
                  class="btn btn--sm primary"
                  onClick={() => props.callbacks.filters.onRefresh()}
                  disabled={props.data.loading}
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
                  class={["btn btn--sm usage-pin-btn", { active: props.display.headerPinned }]}
                  onClick={() => props.callbacks.filters.onToggleHeaderPinned()}
                >
                  {props.display.headerPinned ? t("usage.filters.pinned") : t("usage.filters.pin")}
                </button>
                <wa-dropdown
                  class="usage-export-menu"
                  placement="bottom-end"
                  onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
                    const value = event.detail.item.value;
                    switch (value) {
                      case "sessions-csv":
                      case "daily-csv":
                        downloadTextFile(
                          `openclaw-usage-${value === "sessions-csv" ? "sessions" : "daily"}-${state().exportStamp}.csv`,
                          value === "sessions-csv"
                            ? buildSessionsCsv(state().aggregateSessions)
                            : buildDailyCsv(state().filteredDaily),
                          "text/csv;charset=utf-8",
                        );
                        break;
                      case "json":
                        props.callbacks.display.onExportJson({
                          totals: state().displayTotals,
                          sessions: state().aggregateSessions,
                          daily: state().filteredDaily,
                          aggregates: state().activeAggregates,
                        });
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
                    aria-busy={props.data.exporting ? "true" : "false"}
                  >
                    {props.data.exporting ? t("common.loading") : t("usage.export.label")} ▾
                  </button>
                  <wa-dropdown-item
                    value="sessions-csv"
                    disabled={state().aggregateSessions.length === 0}
                  >
                    {t("usage.export.sessionsCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item value="daily-csv" disabled={state().filteredDaily.length === 0}>
                    {t("usage.export.dailyCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item
                    value="json"
                    disabled={
                      props.data.exporting ||
                      props.data.loading ||
                      (state().aggregateSessions.length === 0 && state().filteredDaily.length === 0)
                    }
                  >
                    {t("usage.export.json")}
                  </wa-dropdown-item>
                </wa-dropdown>
              </div>
            </div>

            <UsageQuerySection
              filters={props.filters}
              actions={props.callbacks.filters}
              loading={props.data.loading}
              hasDraftQuery={state().hasDraftQuery}
              hasQuery={state().hasQuery}
              hasOverviewData={state().hasOverviewData}
              matchingSessions={state().filteredSessions.length}
              totalSessions={state().totalSessions}
              filterOptions={state().filterOptions}
              queryTerms={state().queryTerms}
              querySuggestions={state().querySuggestions}
              queryWarnings={state().queryWarnings}
            />

            {props.data.error ? (
              <div class="callout danger usage-callout">{props.data.error}</div>
            ) : undefined}
            {props.data.cacheRefresh !== "complete" ? (
              <div
                class={[
                  "callout usage-callout usage-cache-warning",
                  { warning: props.data.cacheRefresh === "failed" },
                ]}
                role="status"
                aria-live="polite"
              >
                {t(
                  props.data.cacheRefresh === "failed"
                    ? "usage.cacheStatus.paused"
                    : "usage.cacheStatus.warning",
                )}
              </div>
            ) : undefined}
            {props.data.sessionsLimitReached ? (
              <div class="callout warning usage-callout">{t("usage.sessions.limitReached")}</div>
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
          renderUsageEmptyState(props.callbacks.filters.onRefresh)
        ) : (
          <>
            <div class="settings-group usage-panel usage-left-card usage-trend-section">
              {
                <DailyChartCompact
                  dailyEntries={state().filteredDaily}
                  selectedDays={props.filters.selectedDays}
                  chartMode={props.display.chartMode}
                  dailyChartMode={props.display.dailyChartMode}
                  onDailyChartModeChange={(dailyChartMode) =>
                    props.callbacks.display.onChange({ dailyChartMode })
                  }
                  onSelectDay={props.callbacks.filters.onSelectDay}
                  range={{
                    startDate: props.filters.startDate,
                    endDate: props.filters.endDate,
                    complete: props.data.cacheRefresh === "complete",
                  }}
                />
              }
              <Show when={state().displayTotals}>
                {(totals) => (
                  <CostBreakdownCompact totals={totals()} mode={props.display.chartMode} />
                )}
              </Show>
            </div>
            <UsageCreators
              groups={state().activeAggregates.byCreator ?? []}
              selectedKey={props.filters.creatorKey}
              mode={props.display.chartMode}
              onSelect={(creatorKey) => props.callbacks.filters.onScopeChange({ creatorKey })}
            />
            <UsageInsights
              totals={state().insightTotals}
              aggregates={state().insightAggregates}
              stats={state().insightStats}
              showCostHint={state().hasMissingCost}
              showCostShares={
                /* Daily buckets are exact; category rollups remain full-session totals. */
                props.filters.selectedDays.length === 0
              }
              errorHours={buildPeakErrorHours(state().aggregateSessions, props.filters.timeZone)}
              sessionCount={state().displaySessionCount}
              totalSessions={state().totalSessions}
            />
            {state().costWindowComparison}
            {renderUsageHeatmap(
              state().filteredDaily,
              props.filters.startDate,
              props.filters.endDate,
            )}
            {
              <UsageMosaic
                sessions={state().aggregateSessions}
                timeZone={props.filters.timeZone}
                selectedHours={props.filters.selectedHours}
                onSelectHour={props.callbacks.filters.onSelectHour}
              />
            }

            <div class="usage-grid">
              <div class="usage-grid-column">
                <SessionsCard
                  sessions={state().filteredSessions}
                  usage={props}
                  totalSessions={state().totalSessions}
                />
              </div>
              <Show when={state().primarySelectedEntry}>
                {(selectedSession) => (
                  <div class="usage-grid-column">
                    <SessionDetailPanel
                      session={selectedSession()}
                      detail={props.detail}
                      callbacks={props.callbacks.details}
                      range={props.filters}
                      contextExpanded={props.display.contextExpanded}
                      onClose={() => props.callbacks.filters.onClearSessions()}
                    />
                  </div>
                )}
              </Show>
            </div>
          </>
        )}
        {renderProviderUsage(
          props.data.providerUsage,
          props.data.providerUsageUnavailable,
          props.data.providerUsageStalled,
        )}
      </div>
    </SettingsPage>
  );
}
