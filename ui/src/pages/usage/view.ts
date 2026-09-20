// Control UI view renders usage screen content.
import { html, nothing } from "lit";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import {
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsSegmented,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { downloadTextFile } from "../../lib/download.ts";
import "../../styles/usage.css";
import type { ProviderUsageSummary } from "./data-types.ts";
import { extractQueryTerms, filterSessionsByQuery } from "./helpers.ts";
import {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageInsightStats,
  formatUsageCost,
  formatIsoDate,
  formatUsageTokens,
  renderUsageMosaic,
  sessionTouchesSelectedHours,
} from "./metrics.ts";
import { renderUsageEmptyState, renderUsageLoadingStatus } from "./page-shell.ts";
import {
  applySuggestionToQuery,
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  buildUsageFilterOptions,
  removeQueryToken,
} from "./query.ts";
import type { UsageProps, UsageSessionEntry, UsageTotals } from "./types.ts";
import { renderDailyChartCompact, renderCostBreakdownCompact } from "./view-chart.ts";
import { renderUsageCreatorFilter, renderUsageCreators } from "./view-creators.ts";
import { renderSessionDetailPanel } from "./view-details.ts";
import { renderUsageHeatmap } from "./view-heatmap.ts";
import {
  renderCostWindowComparison,
  renderFilterChips,
  renderSessionsCard,
  renderUsageInsights,
} from "./view-overview.ts";
import { renderUsageQueryFilter } from "./view-query-filter.ts";

type ProviderUsageSnapshot = ProviderUsageSummary["providers"][number];

function renderProviderUsage(
  providers: ProviderUsageSnapshot[],
  unavailable: boolean,
  stalled: boolean,
) {
  const notice = stalled
    ? html`<div class="callout warning usage-callout">${t("usage.providerUsage.stalled")}</div>`
    : unavailable
      ? html`<div class="callout warning usage-callout">
          ${t("usage.providerUsage.unavailable")}
        </div>`
      : nothing;
  if (providers.length === 0) {
    return notice;
  }
  return renderSettingsSection(
    {
      title: t("usage.providerUsage.title"),
      count: providers.length,
      description: t("usage.providerUsage.subtitle"),
    },
    html`
      ${notice}
      <div class="usage-panel provider-usage-section">
        <div class="provider-usage-grid">
          ${providers.map(
            (provider) => html`
              <article class="provider-usage-card">
                <div class="provider-usage-card__header">
                  <div>
                    <div class="provider-usage-card__name">${provider.displayName}</div>
                    <div class="provider-usage-card__id">${provider.provider}</div>
                  </div>
                  ${
                    provider.plan
                      ? html`<span class="provider-usage-plan">${provider.plan}</span>`
                      : nothing
                  }
                </div>
                ${renderProviderUsageDetails(provider)}
              </article>
            `,
          )}
        </div>
      </div>
    `,
  );
}

export function renderUsage(props: UsageProps) {
  const { data, filters, display, detail, callbacks } = props;
  const filterActions = callbacks.filters;
  const displayActions = callbacks.display;
  const detailActions = callbacks.details;

  // Cold caches can list sessions before any usage has been read. Zero-filled
  // aggregate objects are not evidence of zero usage while that read is pending.
  const awaitingUsage =
    data.cacheRefresh !== "complete" &&
    !data.totals?.totalTokens &&
    !data.totals?.totalCost &&
    !data.sessions.some((session) => session.usage?.totalTokens || session.usage?.totalCost) &&
    !data.costDaily.some((day) => day.totalTokens || day.totalCost);
  const hasOverviewData =
    !awaitingUsage && Boolean(data.totals || data.sessions.length || data.costDaily.length);
  const loadingOverview = data.loading || (awaitingUsage && data.cacheRefresh === "retrying");
  const isTokenMode = display.chartMode === "tokens";
  const hasQuery = filters.query.trim().length > 0;
  const hasDraftQuery = filters.queryDraft.trim().length > 0;
  const selectedDaySet = new Set(filters.selectedDays);
  const selectedSessionSet = new Set(filters.selectedSessions);

  // Sort sessions by tokens or cost depending on mode
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

  // Get first selected session for detail view (timeseries, logs)
  const primarySelectedEntry =
    filters.selectedSessions.length === 1
      ? (data.sessions.find((s) => s.key === filters.selectedSessions[0]) ??
        filteredSessions.find((s) => s.key === filters.selectedSessions[0]))
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
  const filteredDaily = hasSessionFilters
    ? (() => {
        const days = new Map<string, UsageTotals>();
        for (const session of scopedSessions) {
          for (const day of session.usage?.dailyBreakdown ?? []) {
            const totals = days.get(day.date) ?? createEmptyCostUsageTotals();
            addCostUsageTotals(totals, day);
            days.set(day.date, totals);
          }
        }
        return Array.from(days, ([date, totals]) => ({ date, ...totals })).toSorted((a, b) =>
          a.date.localeCompare(b.date),
        );
      })()
    : data.costDaily;
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
    ? nothing
    : renderCostWindowComparison(
        data.costDaily,
        filters.startDate,
        filters.endDate,
        filters.timeZone,
      );

  const insightStats = buildUsageInsightStats(aggregateSessions, insightTotals, insightAggregates);
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
  const hasMissingCost =
    (displayTotals?.missingCostEntries ?? 0) > 0 ||
    (displayTotals
      ? displayTotals.totalTokens > 0 &&
        displayTotals.totalCost === 0 &&
        displayTotals.input +
          displayTotals.output +
          displayTotals.cacheRead +
          displayTotals.cacheWrite >
          0
      : false);
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
    filterActions.onStartDateChange(range.start);
    filterActions.onEndDateChange(range.end);
  };
  const applyAllRange = () => {
    filterActions.onStartDateChange("1970-01-01");
    filterActions.onEndDateChange(formatIsoDate(new Date(), filters.timeZone));
  };
  const exportStamp = formatIsoDate(new Date());

  return renderSettingsPage(
    html`
      <div class="usage-page">
        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("usage.filters.rangeTitle")}</h2>
            <div class="settings-section__actions">
              ${loadingOverview ? renderUsageLoadingStatus(t("usage.loading.badge")) : nothing}
              ${
                isEmpty
                  ? html`<span class="usage-query-hint">${t("usage.empty.hint")}</span>`
                  : nothing
              }
            </div>
          </div>
          <div
            class="settings-group usage-panel usage-header ${display.headerPinned ? "pinned" : ""}"
          >
            <div class="usage-header-row">
              <div class="usage-controls">
                ${renderFilterChips(
                  filters.selectedDays,
                  filters.selectedHours,
                  filters.selectedSessions,
                  data.sessions,
                  filterActions.onClearDays,
                  filterActions.onClearHours,
                  filterActions.onClearSessions,
                  filterActions.onClearFilters,
                )}
                <div class="usage-presets">
                  ${datePresets.map(
                    (preset) => html`
                      <button
                        class="btn btn--sm ${isPresetSelected(preset.days) ? "active" : ""}"
                        aria-pressed=${isPresetSelected(preset.days)}
                        @click=${() => applyPreset(preset.days)}
                      >
                        ${preset.label}
                      </button>
                    `,
                  )}
                  <button
                    class="btn btn--sm ${filters.startDate === "1970-01-01" ? "active" : ""}"
                    aria-pressed=${filters.startDate === "1970-01-01"}
                    @click=${applyAllRange}
                  >
                    ${t("usage.presets.all")}
                  </button>
                </div>
                <div class="usage-date-range">
                  <input
                    class="usage-date-input"
                    type="date"
                    .value=${filters.startDate}
                    title=${t("usage.filters.startDate")}
                    aria-label=${t("usage.filters.startDate")}
                    @change=${(e: Event) =>
                      filterActions.onStartDateChange((e.target as HTMLInputElement).value)}
                  />
                  <span class="usage-separator">${t("usage.filters.to")}</span>
                  <input
                    class="usage-date-input"
                    type="date"
                    .value=${filters.endDate}
                    title=${t("usage.filters.endDate")}
                    aria-label=${t("usage.filters.endDate")}
                    @change=${(e: Event) =>
                      filterActions.onEndDateChange((e.target as HTMLInputElement).value)}
                  />
                </div>
                <select
                  class="usage-select"
                  title=${t("usage.filters.timeZone")}
                  aria-label=${t("usage.filters.timeZone")}
                  .value=${filters.timeZone}
                  @change=${(e: Event) =>
                    filterActions.onTimeZoneChange(
                      (e.target as HTMLSelectElement).value as "local" | "utc",
                    )}
                >
                  <option value="local">${t("usage.filters.timeZoneLocal")}</option>
                  <option value="utc">${t("usage.filters.timeZoneUtc")}</option>
                </select>
              </div>
              <div class="usage-view-options">
                ${renderUsageCreatorFilter({
                  options: data.creatorOptions,
                  selectedKey: filters.creatorKey,
                  onSelect: filterActions.onCreatorChange,
                })}
                ${renderSettingsSegmented({
                  mode: "buttons",
                  variant: "accent",
                  ariaPressed: false,
                  value: filters.scope,
                  onChange: filterActions.onScopeChange,
                  onReselect: filterActions.onScopeChange,
                  options: [
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
                  ],
                })}
                ${renderSettingsSegmented({
                  mode: "buttons",
                  variant: "accent",
                  ariaPressed: false,
                  value: isTokenMode ? "tokens" : "cost",
                  onChange: displayActions.onChartModeChange,
                  onReselect: displayActions.onChartModeChange,
                  options: [
                    { value: "tokens", label: t("usage.metrics.tokens") },
                    { value: "cost", label: t("usage.metrics.cost") },
                  ],
                })}
                <button
                  class="btn btn--sm primary"
                  @click=${filterActions.onRefresh}
                  ?disabled=${data.loading}
                >
                  ${t("common.refresh")}
                </button>
              </div>
            </div>

            <div class="usage-header-row">
              <div class="usage-header-metrics">
                ${
                  displayTotals
                    ? html`
                        <span class="usage-metric-badge">
                          <strong>${formatUsageTokens(displayTotals.totalTokens)}</strong>
                          ${t("usage.metrics.tokens")}
                        </span>
                        <span class="usage-metric-badge">
                          <strong>${formatUsageCost(displayTotals.totalCost)}</strong>
                          ${t("usage.metrics.cost")}
                        </span>
                        <span class="usage-metric-badge">
                          <strong>${displaySessionCount}</strong>
                          ${
                            displaySessionCount === 1
                              ? t("usage.metrics.session")
                              : t("usage.metrics.sessions")
                          }
                        </span>
                      `
                    : nothing
                }
                <button
                  class="btn btn--sm usage-pin-btn ${display.headerPinned ? "active" : ""}"
                  @click=${filterActions.onToggleHeaderPinned}
                >
                  ${display.headerPinned ? t("usage.filters.pinned") : t("usage.filters.pin")}
                </button>
                <wa-dropdown
                  class="usage-export-menu"
                  placement="bottom-end"
                  @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                    switch (event.detail.item.value) {
                      case "sessions-csv":
                        downloadTextFile(
                          `openclaw-usage-sessions-${exportStamp}.csv`,
                          buildSessionsCsv(aggregateSessions),
                          "text/csv;charset=utf-8",
                        );
                        break;
                      case "daily-csv":
                        downloadTextFile(
                          `openclaw-usage-daily-${exportStamp}.csv`,
                          buildDailyCsv(filteredDaily),
                          "text/csv;charset=utf-8",
                        );
                        break;
                      case "json":
                        displayActions.onExportJson({
                          totals: displayTotals,
                          sessions: aggregateSessions,
                          daily: filteredDaily,
                          aggregates: activeAggregates,
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
                    aria-busy=${data.exporting}
                  >
                    ${data.exporting ? t("common.loading") : t("usage.export.label")} ▾
                  </button>
                  <wa-dropdown-item
                    value="sessions-csv"
                    ?disabled=${aggregateSessions.length === 0}
                  >
                    ${t("usage.export.sessionsCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item value="daily-csv" ?disabled=${filteredDaily.length === 0}>
                    ${t("usage.export.dailyCsv")}
                  </wa-dropdown-item>
                  <wa-dropdown-item
                    value="json"
                    ?disabled=${
                      data.exporting ||
                      data.loading ||
                      (aggregateSessions.length === 0 && filteredDaily.length === 0)
                    }
                  >
                    ${t("usage.export.json")}
                  </wa-dropdown-item>
                </wa-dropdown>
              </div>
            </div>

            <div class="usage-query-section">
              <div class="usage-query-bar">
                <input
                  class="usage-query-input"
                  type="text"
                  .value=${filters.queryDraft}
                  placeholder=${t("usage.query.placeholder")}
                  @input=${(e: Event) =>
                    filterActions.onQueryDraftChange((e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      filterActions.onApplyQuery();
                    }
                  }}
                />
                <div class="usage-query-actions">
                  <button
                    class="btn btn--sm"
                    @click=${filterActions.onApplyQuery}
                    ?disabled=${data.loading || (!hasDraftQuery && !hasQuery)}
                  >
                    ${t("usage.query.apply")}
                  </button>
                  ${
                    hasDraftQuery || hasQuery
                      ? html`
                          <button class="btn btn--sm" @click=${filterActions.onClearQuery}>
                            ${t("usage.filters.clear")}
                          </button>
                        `
                      : nothing
                  }
                  <span class="usage-query-hint">
                    ${
                      !hasOverviewData
                        ? nothing
                        : hasQuery
                          ? t("usage.query.matching", {
                              shown: String(filteredSessions.length),
                              total: String(totalSessions),
                            })
                          : t("usage.query.inRange", { total: String(totalSessions) })
                    }
                  </span>
                </div>
              </div>
              <div class="usage-filter-row">
                ${renderUsageQueryFilter("channel", t("usage.filters.channel"), filterOptions.channel, filters.queryDraft, filterActions.onQueryDraftChange)}
                ${renderUsageQueryFilter("provider", t("usage.filters.provider"), filterOptions.provider, filters.queryDraft, filterActions.onQueryDraftChange)}
                ${renderUsageQueryFilter("model", t("usage.filters.model"), filterOptions.model, filters.queryDraft, filterActions.onQueryDraftChange)}
                ${renderUsageQueryFilter("tool", t("usage.filters.tool"), filterOptions.tool, filters.queryDraft, filterActions.onQueryDraftChange)}
                <span class="usage-query-hint">${t("usage.query.tip")}</span>
              </div>
              ${
                queryTerms.length > 0
                  ? html`
                      <div class="usage-query-chips">
                        ${queryTerms.map((term) => {
                          const label = term.raw;
                          return html`
                            <span class="usage-query-chip">
                              ${label}
                              <openclaw-tooltip .content=${t("usage.filters.remove")}>
                                <button
                                  aria-label=${t("usage.filters.remove")}
                                  @click=${() =>
                                    filterActions.onQueryDraftChange(
                                      removeQueryToken(filters.queryDraft, label),
                                    )}
                                >
                                  ×
                                </button>
                              </openclaw-tooltip>
                            </span>
                          `;
                        })}
                      </div>
                    `
                  : nothing
              }
              ${
                querySuggestions.length > 0
                  ? html`
                      <div class="usage-query-suggestions">
                        ${querySuggestions.map(
                          (suggestion) => html`
                            <button
                              class="usage-query-suggestion"
                              @click=${() =>
                                filterActions.onQueryDraftChange(
                                  applySuggestionToQuery(filters.queryDraft, suggestion.value),
                                )}
                            >
                              ${suggestion.label}
                            </button>
                          `,
                        )}
                      </div>
                    `
                  : nothing
              }
              ${
                queryWarnings.length > 0
                  ? html`
                      <div class="callout warning usage-callout usage-callout--tight">
                        ${queryWarnings.join(" · ")}
                      </div>
                    `
                  : nothing
              }
            </div>

            ${
              data.error
                ? html`<div class="callout danger usage-callout">${data.error}</div>`
                : nothing
            }
            ${
              data.cacheRefresh !== "complete"
                ? html`
                    <div
                      class="callout ${data.cacheRefresh === "exhausted" ? "warning" : ""} usage-callout usage-cache-warning"
                      role="status"
                      aria-live="polite"
                    >
                      ${t(
                        data.cacheRefresh === "exhausted"
                          ? "usage.cacheStatus.paused"
                          : "usage.cacheStatus.warning",
                      )}
                    </div>
                  `
                : nothing
            }
            ${
              data.sessionsLimitReached
                ? html`
                    <div class="callout warning usage-callout">
                      ${t("usage.sessions.limitReached")}
                    </div>
                  `
                : nothing
            }
          </div>
        </section>

        ${
          !hasOverviewData
            ? loadingOverview
              ? html`<div class="usage-panel usage-loading-card">
                  <div class="usage-loading-grid">
                    <div class="skeleton usage-skeleton-block usage-skeleton-block--tall"></div>
                    <div class="skeleton usage-skeleton-block"></div>
                    <div class="skeleton usage-skeleton-block"></div>
                  </div>
                </div>`
              : nothing
            : isEmpty
              ? renderUsageEmptyState(filterActions.onRefresh)
              : html`
                  <div class="settings-group usage-panel usage-left-card usage-trend-section">
                    ${renderDailyChartCompact(
                      filteredDaily,
                      filters.selectedDays,
                      display.chartMode,
                      display.dailyChartMode,
                      displayActions.onDailyChartModeChange,
                      filterActions.onSelectDay,
                      {
                        startDate: filters.startDate,
                        endDate: filters.endDate,
                        complete: data.cacheRefresh === "complete",
                      },
                    )}
                    ${
                      displayTotals
                        ? renderCostBreakdownCompact(displayTotals, display.chartMode)
                        : nothing
                    }
                  </div>
                  ${renderUsageCreators({
                    groups: activeAggregates.byCreator ?? [],
                    selectedKey: filters.creatorKey,
                    mode: display.chartMode,
                    onSelect: filterActions.onCreatorChange,
                  })}
                  ${renderUsageInsights(
                    insightTotals,
                    insightAggregates,
                    insightStats,
                    hasMissingCost,
                    // Day totals are exact daily buckets; category rollups remain full-session totals.
                    // Hide shares instead of mixing those scopes into percentages above 100%.
                    filters.selectedDays.length === 0,
                    buildPeakErrorHours(aggregateSessions, filters.timeZone),
                    displaySessionCount,
                    totalSessions,
                  )}
                  ${costWindowComparison}
                  ${renderUsageHeatmap(filteredDaily, filters.startDate, filters.endDate)}
                  ${renderUsageMosaic(
                    aggregateSessions,
                    filters.timeZone,
                    filters.selectedHours,
                    filterActions.onSelectHour,
                  )}

                  <div class="usage-grid">
                    <div class="usage-grid-column">
                      ${renderSessionsCard(
                        filteredSessions,
                        filters.selectedSessions,
                        filters.selectedDays,
                        isTokenMode,
                        display.sessionSort,
                        display.sessionSortDir,
                        display.recentSessions,
                        display.sessionsTab,
                        detailActions.onSelectSession,
                        displayActions.onSessionSortChange,
                        displayActions.onSessionSortDirChange,
                        displayActions.onSessionsTabChange,
                        display.visibleColumns,
                        totalSessions,
                        filterActions.onClearSessions,
                      )}
                    </div>
                    ${
                      primarySelectedEntry
                        ? html`<div class="usage-grid-column">
                            ${renderSessionDetailPanel(
                              primarySelectedEntry,
                              detail.timeSeries,
                              detail.timeSeriesLoading,
                              detail.timeSeriesStatus,
                              detail.timeSeriesMode,
                              detailActions.onTimeSeriesModeChange,
                              detail.timeSeriesBreakdownMode,
                              detailActions.onTimeSeriesBreakdownChange,
                              detail.timeSeriesCursorStart,
                              detail.timeSeriesCursorEnd,
                              detailActions.onTimeSeriesCursorRangeChange,
                              filters.startDate,
                              filters.endDate,
                              filters.selectedDays,
                              filters.timeZone,
                              detail.sessionLogs,
                              detail.sessionLogsLoading,
                              detail.sessionLogsStatus,
                              detail.sessionLogsExpanded,
                              detailActions.onToggleSessionLogsExpanded,
                              detail.logFilters,
                              detailActions.onLogFilterRolesChange,
                              detailActions.onLogFilterToolsChange,
                              detailActions.onLogFilterHasToolsChange,
                              detailActions.onLogFilterQueryChange,
                              detailActions.onLogFilterClear,
                              detail.context,
                              display.contextExpanded,
                              detailActions.onToggleContextExpanded,
                              filterActions.onClearSessions,
                            )}
                          </div>`
                        : nothing
                    }
                  </div>
                `
        }
        ${renderProviderUsage(
          data.providerUsage,
          data.providerUsageUnavailable,
          data.providerUsageStalled,
        )}
      </div>
    `,
    { wide: true },
  );
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
