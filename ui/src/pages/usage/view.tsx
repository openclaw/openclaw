import { For, Show, createMemo } from "solid-js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { Menu } from "../../components/solid/menu.tsx";
import { renderProviderUsageDetails } from "../../components/solid/provider-usage.tsx";
import {
  SettingsSection,
  SettingsPage,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../components/tooltip.ts";
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
  const overview = createMemo(() => resolveUsageOverviewState(props.data));
  const displayTotals = createMemo(() => (overview().hasOverviewData ? props.data.totals : null));
  const filterOptions = createMemo(
    () =>
      props.data.overview?.filterOptions ?? {
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
  const primarySelectedEntry = createMemo(() =>
    props.filters.selectedSessions.length === 1 && props.data.overview?.selectedRowCount !== 0
      ? (props.data.selectedSession ??
        props.data.sessions.find((session) => session.key === props.filters.selectedSessions[0]))
      : null,
  );
  const totalSessions = createMemo(
    () =>
      props.data.overview?.unfilteredSessionCount ??
      props.data.aggregates?.sessionCount ??
      props.data.sessions.length,
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
      [
        totals ? formatUsageTokens(totals.totalTokens, totals.usageReport) : empty,
        t("usage.metrics.tokens"),
      ],
      [
        totals ? formatUsageCost(totals.totalCost, 2, totals.usageReport) : empty,
        t("usage.metrics.cost"),
      ],
      [
        totals ? String(sessions) : empty,
        t(sessions === 1 ? "usage.metrics.session" : "usage.metrics.sessions"),
      ],
    ];
  });
  const exportSessionCount = createMemo(
    () => props.data.overview?.selectedRowCount ?? displaySessionCount(),
  );
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
  const isEmpty = createMemo(
    () =>
      props.data.cacheRefresh === "complete" &&
      props.data.totals !== null &&
      !props.data.loading &&
      !props.data.error &&
      props.data.sessions.length === 0 &&
      (props.data.overview?.unfilteredSessionCount ?? 0) === 0 &&
      (props.data.totals?.totalTokens ?? 0) === 0,
  );
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
  const isPresetSelected = (days: number) => {
    const range = presetRange(days);
    return props.filters.startDate === range.start && props.filters.endDate === range.end;
  };
  const applyPreset = (days: number) => {
    const range = presetRange(days);
    props.callbacks.filters.onDatesChange({ startDate: range.start });
    props.callbacks.filters.onDatesChange({ endDate: range.end });
  };
  const applyAllRange = () => {
    props.callbacks.filters.onDatesChange({ startDate: "1970-01-01" });
    props.callbacks.filters.onDatesChange({
      endDate: formatIsoDate(new Date(), props.filters.timeZone),
    });
  };
  return (
    <SettingsPage wide>
      <div class="usage-page">
        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">{t("usage.filters.rangeTitle")}</h2>
            <div class="settings-section__actions">
              {overview().loadingOverview
                ? renderUsageLoadingStatus(t("usage.loading.badge"))
                : undefined}
              {isEmpty() ? (
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
                {renderFilterChips(props.data.overview?.selectedRows ?? props.data.sessions, props)}
                <div class="usage-presets">
                  <For each={datePresets}>
                    {(preset) => (
                      <button
                        class={["btn btn--sm", { active: isPresetSelected(preset.days) }]}
                        aria-pressed={isPresetSelected(preset.days) ? "true" : "false"}
                        onClick={() => applyPreset(preset.days)}
                      >
                        {t(preset.labelKey)}
                      </button>
                    )}
                  </For>
                  <button
                    class={["btn btn--sm", { active: props.filters.startDate === "1970-01-01" }]}
                    aria-pressed={props.filters.startDate === "1970-01-01" ? "true" : "false"}
                    onClick={() => applyAllRange()}
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
                  value={props.display.chartMode === "tokens" ? "tokens" : "cost"}
                  onChange={(chartMode) => props.callbacks.display.onChange({ chartMode })}
                  onReselect={(chartMode) => props.callbacks.display.onChange({ chartMode })}
                  options={[
                    { value: "tokens", label: t("usage.metrics.tokens") },
                    { value: "cost", label: t("usage.metrics.cost") },
                  ]}
                />
                <button
                  class="btn btn--sm primary"
                  onClick={() => void props.callbacks.filters.onRefresh()}
                  disabled={props.data.loading}
                >
                  {t("common.refresh")}
                </button>
              </div>
            </div>

            <div class="usage-header-row">
              <div class="usage-header-metrics">
                {/* Badges render before totals arrive so the row keeps its height. */}
                <For each={metricBadges()}>
                  {([value, label]) => (
                    <span class="usage-metric-badge">
                      <strong>{value}</strong> {label}
                    </span>
                  )}
                </For>
                {/* One actions group, so the badge row's wrapping never moves Pin or Export. */}
                <div class="usage-header-actions">
                  <button
                    class={["btn btn--sm usage-pin-btn", { active: props.display.headerPinned }]}
                    onClick={() => props.callbacks.filters.onToggleHeaderPinned()}
                  >
                    {props.display.headerPinned
                      ? t("usage.filters.pinned")
                      : t("usage.filters.pin")}
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
                          props.data.loading ||
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
            </div>

            <UsageQuerySection
              filters={props.filters}
              actions={props.callbacks.filters}
              loading={props.data.loading}
              hasDraftQuery={props.filters.queryDraft.trim().length > 0}
              hasQuery={props.filters.query.trim().length > 0}
              hasOverviewData={overview().hasOverviewData}
              matchingSessions={
                props.data.sessionPage?.total ??
                props.data.overview?.total ??
                props.data.sessions.length
              }
              totalSessions={totalSessions()}
              filterOptions={filterOptions()}
              queryTerms={queryTerms()}
              querySuggestions={querySuggestions()}
              queryWarnings={props.data.overview?.queryWarnings ?? []}
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
          </div>
        </section>

        {!overview().hasOverviewData ? (
          overview().loadingOverview ? (
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
        ) : (
          <>
            {/* Interrupted responses leave known subtotals: keep the analytics and mark them as lower bounds. */}
            <Show
              when={
                displayTotals()?.usageReport?.state === "unavailable" ||
                props.data.overview?.usageReport?.state === "unavailable"
              }
            >
              <div class="callout usage-callout" role="note">
                {t("usage.lowerBound")}
              </div>
            </Show>
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
                showCostShares={
                  /* Daily buckets are exact; category rollups remain full-session totals. */
                  props.filters.selectedDays.length === 0
                }
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
              {renderUsageHeatmap(
                props.data.costDaily,
                props.filters.startDate,
                props.filters.endDate,
              )}
              {
                <UsageMosaic
                  overview={props.data.overview}
                  timeZone={props.filters.timeZone}
                  selectedHours={props.filters.selectedHours}
                  onSelectHour={props.callbacks.filters.onSelectHour}
                />
              }
            </>

            <div class="usage-grid">
              <div class="usage-grid-column">
                <SessionsCard
                  sessions={props.data.sessions}
                  usage={props}
                  totalSessions={props.data.overview?.total ?? totalSessions()}
                  overview={props.data.sessionPage ?? props.data.overview}
                  loading={props.data.loading}
                />
              </div>
              <Show when={primarySelectedEntry()}>
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
