import { For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { extractQueryTerms } from "./helpers.ts";
import { applySuggestionToQuery, removeQueryToken } from "./query.ts";
import type { buildQuerySuggestions, buildUsageFilterOptions } from "./query.ts";
import type { UsageProps } from "./types.ts";
import { UsageQueryFilter } from "./view-query-filter.tsx";

export function UsageQuerySection(props: {
  filters: UsageProps["filters"];
  actions: UsageProps["callbacks"]["filters"];
  loading: boolean;
  hasDraftQuery: boolean;
  hasQuery: boolean;
  hasOverviewData: boolean;
  matchingSessions: number;
  totalSessions: number;
  filterOptions: ReturnType<typeof buildUsageFilterOptions>;
  queryTerms: ReturnType<typeof extractQueryTerms>;
  querySuggestions: ReturnType<typeof buildQuerySuggestions>;
  queryWarnings: string[];
}) {
  return (
    <div class="usage-query-section">
      <div class="usage-query-bar">
        <input
          class="usage-query-input"
          type="text"
          value={props.filters.queryDraft}
          aria-label={t("usage.query.placeholder")}
          placeholder={t("usage.query.placeholder")}
          onInput={(event) => props.actions.onQueryDraftChange(event.currentTarget.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              props.actions.onApplyQuery();
            }
          }}
        />
        <div class="usage-query-actions">
          <button
            class="btn btn--sm"
            onClick={() => props.actions.onApplyQuery()}
            disabled={props.loading || (!props.hasDraftQuery && !props.hasQuery)}
          >
            {t("usage.query.apply")}
          </button>
          {props.hasDraftQuery || props.hasQuery ? (
            <button class="btn btn--sm" onClick={() => props.actions.onClearQuery()}>
              {t("usage.filters.clear")}
            </button>
          ) : undefined}
          <span class="usage-query-hint">
            {!props.hasOverviewData
              ? undefined
              : props.hasQuery
                ? t("usage.query.matching", {
                    shown: String(props.matchingSessions),
                    total: String(props.totalSessions),
                  })
                : t("usage.query.inRange", { total: String(props.totalSessions) })}
          </span>
        </div>
      </div>
      <div class="usage-filter-row">
        <UsageQueryFilter
          filterKey="channel"
          label={t("usage.filters.channel")}
          options={props.filterOptions.channel}
          queryDraft={props.filters.queryDraft}
          onQueryDraftChange={props.actions.onQueryDraftChange}
        />
        <UsageQueryFilter
          filterKey="provider"
          label={t("usage.filters.provider")}
          options={props.filterOptions.provider}
          queryDraft={props.filters.queryDraft}
          onQueryDraftChange={props.actions.onQueryDraftChange}
        />
        <UsageQueryFilter
          filterKey="model"
          label={t("usage.filters.model")}
          options={props.filterOptions.model}
          queryDraft={props.filters.queryDraft}
          onQueryDraftChange={props.actions.onQueryDraftChange}
        />
        <UsageQueryFilter
          filterKey="tool"
          label={t("usage.filters.tool")}
          options={props.filterOptions.tool}
          queryDraft={props.filters.queryDraft}
          onQueryDraftChange={props.actions.onQueryDraftChange}
        />
        <span class="usage-query-hint">{t("usage.query.tip")}</span>
      </div>
      {props.queryTerms.length > 0 ? (
        <div class="usage-query-chips">
          <For each={props.queryTerms}>
            {(term) => {
              const label = term.raw;
              return (
                <span class="usage-query-chip">
                  {label}
                  <openclaw-tooltip prop:content={t("usage.filters.remove")}>
                    <button
                      aria-label={t("usage.filters.remove")}
                      onClick={() =>
                        props.actions.onQueryDraftChange(
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
      {props.querySuggestions.length > 0 ? (
        <div class="usage-query-suggestions">
          <For each={props.querySuggestions}>
            {(suggestion) => (
              <button
                class="usage-query-suggestion"
                onClick={() =>
                  props.actions.onQueryDraftChange(
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
      {props.queryWarnings.length > 0 ? (
        <div class="callout warning usage-callout usage-callout--tight">
          {props.queryWarnings.join(" · ")}
        </div>
      ) : undefined}
    </div>
  );
}
