import type { JSX } from "@solidjs/web";
import { For, Show, createMemo } from "solid-js";
import { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { formatIsoDate } from "./helpers.ts";
import { applySuggestionToQuery, buildQuerySuggestions, removeQueryToken } from "./query.ts";
import type { UsageProps } from "./types.ts";
import { UsageCreatorFilter } from "./view-creators.tsx";
import { UsageFilterSheet } from "./view-filter-sheet.tsx";
import { UsageQueryFilter } from "./view-query-filter.tsx";

export type UsageControlsProps = UsageProps & {
  /** Phone widths move the agent picker from the page header into the toolbar. */
  agentScope?: () => JSX.Element;
};

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

/** The page's controls, arranged as the full toolbar or as presets, metric and a filter sheet. */
export function createUsageControls(
  props: UsageControlsProps,
  ctx: {
    loading: () => boolean;
    phone: () => boolean;
    hasOverviewData: () => boolean;
    displaySessionCount: () => number;
    selectionChips: () => JSX.Element;
  },
) {
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
  const application = useOptionalApplication();
  const gateway = application ? projectGateway(application.gateway) : undefined;
  // "You" leads the identity picker; the viewer is the Gateway's signed-in profile.
  const viewerId = () => gateway?.read().snapshot.selfUser?.id ?? null;
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
  const totalSessions = () =>
    props.data.overview?.unfilteredSessionCount ??
    props.data.aggregates?.sessionCount ??
    props.data.sessions.length;
  const partialNotice = () => props.data.partialNotice ?? "";
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
  // Everything behind the phone filter button; presets and metric stay on the page.
  const filtersActive = () =>
    selectedPreset() === "" ||
    props.filters.timeZone !== "local" ||
    props.filters.creatorKey !== null ||
    props.filters.scope !== "family" ||
    hasDraftQuery() ||
    hasQuery();
  const presetsControl = () => (
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
  );
  const startDateInput = () => (
    <DateInput
      value={props.filters.startDate}
      label={t("usage.filters.startDate")}
      onChange={(startDate) => props.callbacks.filters.onDatesChange({ startDate })}
    />
  );
  const endDateInput = () => (
    <DateInput
      value={props.filters.endDate}
      label={t("usage.filters.endDate")}
      onChange={(endDate) => props.callbacks.filters.onDatesChange({ endDate })}
    />
  );
  const timeZoneSelect = () => (
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
  );
  const creatorFilter = () => (
    <UsageCreatorFilter
      options={props.data.creatorOptions}
      selectedKey={props.filters.creatorKey}
      viewerId={viewerId()}
      placement={ctx.phone() ? "top-start" : "bottom-start"}
      onSelect={(creatorKey) => props.callbacks.filters.onScopeChange({ creatorKey })}
    />
  );
  const scopeControl = () => (
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
  );
  const metricControl = () => (
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
  );
  const partialStatus = () => (
    /* One fixed slot: the incomplete-data chip, laid out even when hidden so nothing reflows. */
    <span class="usage-summary-strip__status">
      <openclaw-tooltip
        open-on-click
        class={["usage-partial-notice", { "usage-partial-notice--off": !partialNotice() }]}
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
  );
  const queryBar = () => (
    <div class="usage-query-bar">
      <input
        class="usage-query-input"
        type="text"
        value={props.filters.queryDraft}
        aria-label={t("usage.query.placeholder")}
        placeholder={t("usage.query.placeholder")}
        onBlur={clearCompositionEnd}
        onCompositionEnd={recordCompositionEnd}
        onKeyUp={clearCompositionEnd}
        onInput={(event) => props.callbacks.filters.onQueryDraftChange(event.currentTarget.value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (isComposingKeyboardEvent(e)) {
            return;
          }
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
          disabled={ctx.loading() || (!hasDraftQuery() && !hasQuery())}
        >
          {t("usage.query.apply")}
        </button>
        {hasDraftQuery() || hasQuery() ? (
          <button class="btn btn--sm" onClick={() => props.callbacks.filters.onClearQuery()}>
            {t("usage.filters.clear")}
          </button>
        ) : undefined}
      </div>
    </div>
  );
  const facetFilters = () => (
    <For each={["channel", "provider", "model", "tool"] as const}>
      {(filterKey) => (
        <UsageQueryFilter
          filterKey={filterKey}
          label={t(`usage.filters.${filterKey}`)}
          options={filterOptions()[filterKey]}
          counts={
            props.data.readChartSnapshot("filterOptions")?.overview?.filterOptionCounts?.[filterKey]
          }
          queryDraft={props.filters.queryDraft}
          queryTerms={queryTerms()}
          onQueryDraftChange={props.callbacks.filters.onQueryDraftChange}
          placement={ctx.phone() ? "top-start" : "bottom-start"}
        />
      )}
    </For>
  );
  const queryCount = () => (
    /* Last in the row, so the count arriving with data moves nothing. */
    <span class="usage-query-hint usage-query-count">
      {!ctx.hasOverviewData()
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
  );
  // The range total only repeats the Sessions tile, so phones show it when the two differ.
  const hasAppliedFilters = () =>
    queryTerms().length > 0 ||
    props.filters.selectedDays.length > 0 ||
    props.filters.selectedHours.length > 0 ||
    props.filters.selectedSessions.length > 0;
  const showPhoneCount = () =>
    ctx.hasOverviewData() && (hasQuery() || totalSessions() !== ctx.displaySessionCount());
  const queryChips = () =>
    queryTerms().length > 0 ? (
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
    ) : undefined;
  const querySuggestionList = () =>
    querySuggestions().length > 0 ? (
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
    ) : undefined;
  const queryWarningCallout = () =>
    queryWarnings().length > 0 ? (
      <InlineAlert tone="warning" class="usage-callout usage-callout--tight">
        {queryWarnings().join(" · ")}
      </InlineAlert>
    ) : undefined;
  const toolbar = () => (
    <>
      {ctx.phone() ? (
        <div class="usage-toolbar usage-toolbar--phone">
          {presetsControl()}
          <div class="usage-toolbar__row">
            {props.agentScope?.()}
            {metricControl()}
            <UsageFilterSheet active={filtersActive()}>
              <div class="usage-filter-sheet__fields">
                <label class="field">
                  <span>{t("usage.filters.startDate")}</span>
                  {startDateInput()}
                </label>
                <label class="field">
                  <span>{t("usage.filters.endDate")}</span>
                  {endDateInput()}
                </label>
                <label class="field">
                  <span>{t("usage.filters.timeZone")}</span>
                  {timeZoneSelect()}
                </label>
                <label class="field">
                  <span>{t("usage.creators.identity")}</span>
                  {creatorFilter()}
                </label>
              </div>
              {scopeControl()}
              <div class="usage-query-section">
                {queryBar()}
                {querySuggestionList()}
              </div>
              <div class="usage-filter-sheet__facets">{facetFilters()}</div>
            </UsageFilterSheet>
          </div>
        </div>
      ) : (
        <div class="usage-toolbar">
          <div class="usage-controls">
            {presetsControl()}
            <div class="usage-date-range">
              {startDateInput()}
              <span class="usage-separator">{t("usage.filters.to")}</span>
              {endDateInput()}
            </div>
            {timeZoneSelect()}
          </div>
          <div class="usage-view-options">
            {creatorFilter()}
            {scopeControl()}
            {metricControl()}
            <RefreshButton
              label={t("common.refresh")}
              onClick={() => void props.callbacks.filters.onRefresh()}
              busy={ctx.loading()}
            />
          </div>
        </div>
      )}
    </>
  );
  const querySection = () => (
    <>
      {ctx.phone() ? (
        <Show when={hasAppliedFilters() || queryWarnings().length > 0 || showPhoneCount()}>
          <div class="usage-query-section">
            <Show when={hasAppliedFilters()}>
              <div class="usage-applied-filters">
                {ctx.selectionChips()}
                {queryChips()}
              </div>
            </Show>
            <Show when={showPhoneCount()}>{queryCount()}</Show>
            {queryWarningCallout()}
          </div>
        </Show>
      ) : (
        <div class="usage-query-section">
          {queryBar()}
          <div class="usage-filter-row">
            {facetFilters()}
            <span class="usage-query-hint">{t("usage.query.tip")}</span>
            {queryCount()}
          </div>
          {queryChips()}
          {querySuggestionList()}
          {queryWarningCallout()}
        </div>
      )}
    </>
  );
  return { toolbar, querySection, partialStatus, partialNotice };
}
