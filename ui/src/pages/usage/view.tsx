import { For, Show, createMemo } from "solid-js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { ProviderUsagePanel } from "../../components/solid/provider-usage.tsx";
import {
  SettingsSection,
  SettingsPage,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import "../../components/tooltip.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import "../../styles/usage.css";
import type { ProviderUsageSummary } from "./data-types.ts";
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
import { renderUsageHeatmap } from "./view-heatmap.tsx";
import { renderCostWindowComparison, renderFilterChips, UsageInsights } from "./view-overview.tsx";
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

function renderProviderUsage(
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
  const overview = createMemo(() => {
    const data = props.data;
    const pending = loading();
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
  });
  const lowerBound = () =>
    displayTotals()?.usageReport?.state === "unavailable" ||
    props.data.overview?.usageReport?.state === "unavailable";
  // One quiet explanation for incomplete data: lower-bound totals and partial gateway answers.
  const incompleteNote = () =>
    [lowerBound() ? t("usage.lowerBound") : "", props.data.partialNotice ?? ""]
      .filter(Boolean)
      .join(" ");
  const providerSeries = createMemo(() =>
    buildProviderSeries(props.data.aggregates?.modelDaily ?? []),
  );
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
      [
        totals ? formatUsageTokens(totals.totalTokens, totals.usageReport) : empty,
        t("usage.metrics.tokens"),
      ],
      [
        totals ? formatUsageCost(totals.totalCost, 2, totals.usageReport) : empty,
        t("usage.metrics.cost"),
      ],
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
  const isEmpty = () =>
    props.data.cacheRefresh === "complete" &&
    props.data.totals !== null &&
    !loading() &&
    !props.data.error &&
    props.data.sessions.length === 0 &&
    (props.data.overview?.unfilteredSessionCount ?? 0) === 0 &&
    (props.data.totals?.totalTokens ?? 0) === 0;
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
                    class={["usage-lower-bound", { "usage-lower-bound--off": !incompleteNote() }]}
                    role="note"
                    aria-hidden={incompleteNote() ? undefined : "true"}
                  >
                    <button
                      type="button"
                      class="usage-lower-bound__chip"
                      tabindex={incompleteNote() ? undefined : -1}
                    >
                      {lowerBound() ? t("usage.lowerBoundShort") : t("usage.partialShort")}
                    </button>
                    <span slot="content">{incompleteNote()}</span>
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
        {renderProviderUsage(
          props.data.providerUsage,
          props.data.providerUsageUnavailable,
          props.data.providerUsageStalled,
        )}
      </div>
    </SettingsPage>
  );
}
