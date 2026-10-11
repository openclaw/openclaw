import { createMemo, For } from "solid-js";
import { cronRunEntryMatchesLink } from "../../../../src/cron/run-link.js";
import type { CronRunLogEntry, CronDeliveryStatus, CronRunsStatusValue } from "../../api/types.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/web-awesome.ts";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { i18n } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { formatDurationCompact, formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  formatRelativeTimestamp,
  createMsFormatter,
  formatCompactTokenCount,
} from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { CronProps } from "./view-types.ts";
registerEnglishCatalog(registerCronEnglish);
type CronRunsSectionProps = Pick<
  CronProps,
  | "runs"
  | "runsState"
  | "highlightedRunId"
  | "runsHasMore"
  | "runsLoadingMore"
  | "runsStatuses"
  | "runsDeliveryStatuses"
  | "runsQuery"
  | "runsSortDir"
  | "onLoadMoreRuns"
  | "onRefresh"
  | "onRunsFiltersChange"
  | "onViewRunTranscript"
> & {
  conditionActivity?: {
    checkCount: number;
    lastCheckedAtMs?: number;
    lastFiredAtMs?: number;
  };
};
function ConditionMetric(props: { label: string; value: string }) {
  return (
    <div class="cron-condition-activity__metric">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}
function ConditionActivity(props: {
  activity: NonNullable<CronRunsSectionProps["conditionActivity"]>;
}) {
  const lastChecked = () =>
    formatRelativeTimestamp(props.activity.lastCheckedAtMs, {
      fallback: t("cron.runs.notChecked"),
    });
  const lastFired = () =>
    formatRelativeTimestamp(props.activity.lastFiredAtMs, {
      fallback: t("cron.runs.neverFired"),
    });
  return (
    <div class="cron-condition-activity" data-test-id="cron-condition-activity">
      <div class="cron-condition-activity__intro">
        <div class="settings-row__title">
          <span class="cron-condition-activity__icon" aria-hidden="true">
            <Icon name="gitBranch" />
          </span>
          {t("cron.runs.conditionActivity")}
        </div>
        <div class="settings-row__desc">{t("cron.runs.conditionActivityHint")}</div>
      </div>
      <dl class="cron-condition-activity__metrics">
        <ConditionMetric label={t("cron.runs.checks")} value={String(props.activity.checkCount)} />
        <ConditionMetric label={t("cron.runs.lastChecked")} value={lastChecked()} />
        <ConditionMetric label={t("cron.runs.lastFired")} value={lastFired()} />
      </dl>
    </div>
  );
}
function conditionEmptyHint(activity: NonNullable<CronRunsSectionProps["conditionActivity"]>) {
  if (activity.checkCount === 0) {
    return t("cron.runs.emptyConditionUnchecked");
  }
  const key =
    activity.checkCount === 1 ? "cron.runs.emptyConditionHintOne" : "cron.runs.emptyConditionHint";
  return t(key, { count: String(activity.checkCount) });
}
const RUN_STATUS_LABELS = new Map<CronRunsStatusValue, string>([
  ["ok", "cron.runs.runStatusOk"],
  ["error", "cron.runs.runStatusError"],
  ["skipped", "cron.runs.runStatusSkipped"],
]);
const RUN_DELIVERY_LABELS = new Map<CronDeliveryStatus, string>([
  ["delivered", "cron.runs.deliveryDelivered"],
  ["not-delivered", "cron.runs.deliveryNotDelivered"],
  ["unknown", "cron.runs.deliveryUnknown"],
  ["not-requested", "cron.runs.deliveryNotRequested"],
]);
function toggleSelection<T extends string>(selected: T[], value: T, checked: boolean): T[] {
  const set = new Set(selected);
  if (checked) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return Array.from(set);
}
const FILTER_OPTION_PREFIX = "option:";
const FILTER_COMMAND_PREFIX = "command:";
function FilterDropdown<T extends string>(props: {
  id: string;
  title: string;
  allLabel: string;
  options: Array<{
    value: T;
    label: string;
  }>;
  selected: T[];
  onToggle: (value: T, checked: boolean) => void;
  onClear: () => void;
}) {
  const selectedLabels = createMemo(() =>
    props.options
      .filter((option) => props.selected.includes(option.value))
      .map((option) => option.label),
  );
  const summary = createMemo(() =>
    selectedLabels().length === 0
      ? props.allLabel
      : selectedLabels().length <= 2
        ? selectedLabels().join(", ")
        : `${selectedLabels()[0]} +${selectedLabels().length - 1}`,
  );
  const accessibleSummary = createMemo(() =>
    selectedLabels().length > 2
      ? `${summary()} (${new Intl.ListFormat(i18n.getLocale(), {
          style: "long",
          type: "conjunction",
        }).format(selectedLabels())})`
      : summary(),
  );
  return (
    <div class="cron-filter-dropdown" data-filter={props.id}>
      <wa-dropdown
        class="cron-filter-dropdown__details"
        placement="bottom-start"
        onWa-select={(
          event: CustomEvent<{
            item: {
              value?: string;
            };
          }>,
        ) => {
          const value = event.detail.item.value;
          if (value === `${FILTER_COMMAND_PREFIX}clear`) {
            props.onClear();
            return;
          }
          if (value?.startsWith(FILTER_OPTION_PREFIX)) {
            event.preventDefault();
            const option = props.options.find(
              (candidate) => candidate.value === value.slice(FILTER_OPTION_PREFIX.length),
            );
            if (option) {
              props.onToggle(option.value, !props.selected.includes(option.value));
            }
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class={[
            "btn btn--sm cron-filter-dropdown__trigger",
            { active: props.selected.length > 0 },
          ]}
          title={props.title}
          aria-label={`${props.title} ${accessibleSummary()}`}
        >
          <span>{summary()}</span>
          <Icon name="chevronDown" />
        </button>
        <For each={props.options} keyed={(option) => option.value}>
          {(option) => (
            <wa-dropdown-item
              class="cron-filter-dropdown__option"
              type="checkbox"
              value={`${FILTER_OPTION_PREFIX}${option().value}`}
              prop:checked={props.selected.includes(option().value)}
            >
              {option().label}
            </wa-dropdown-item>
          )}
        </For>
        <div class="session-menu__separator" role="separator" />
        <wa-dropdown-item value={`${FILTER_COMMAND_PREFIX}clear`}>
          {t("cron.runs.clear")}
        </wa-dropdown-item>
      </wa-dropdown>
    </div>
  );
}
export function RunsSection(props: CronRunsSectionProps) {
  const formatTimestamp = createMemo(() => createMsFormatter(undefined, t("common.na")));
  const runs = createMemo(() => {
    const ascending = props.runsSortDir === "asc";
    return props.runs.toSorted((a, b) => (ascending ? a.ts - b.ts : b.ts - a.ts));
  });
  const hasRunFilters = () =>
    Boolean(props.highlightedRunId) ||
    props.runsQuery.trim().length > 0 ||
    props.runsStatuses.length > 0 ||
    props.runsDeliveryStatuses.length > 0;
  const sortLabel = () =>
    props.runsSortDir === "asc" ? t("cron.runs.oldestFirst") : t("cron.runs.newestFirst");
  return (
    <div class="cron-runs" aria-busy={props.runsState === "pending" ? "true" : "false"}>
      {props.conditionActivity ? (
        <ConditionActivity activity={props.conditionActivity} />
      ) : undefined}
      {props.highlightedRunId ? (
        <div class="row">
          <span>{t("cron.linkedRun.label")}</span>
          <button
            class="btn btn--sm"
            onClick={() => void props.onRunsFiltersChange({ cronRunsRunId: null })}
          >
            {t("cron.linkedRun.showAll")}
          </button>
        </div>
      ) : undefined}
      <div class="cron-run-filters">
        <div class="cron-search-box cron-run-filter-search">
          <span class="cron-search-box__icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            type="search"
            class="settings-input"
            value={props.runsQuery}
            aria-label={t("cron.runs.searchRuns")}
            placeholder={t("cron.runs.searchPlaceholder")}
            onInput={(e) =>
              void props.onRunsFiltersChange({
                cronRunsQuery: e.currentTarget.value,
              })
            }
          />
        </div>
        <FilterDropdown
          id="status"
          title={t("cron.runs.status")}
          allLabel={t("cron.runs.allStatuses")}
          options={Array.from(RUN_STATUS_LABELS, ([value, key]) => ({
            value,
            label: t(key),
          }))}
          selected={props.runsStatuses}
          onToggle={(value, checked) => {
            const next = toggleSelection(props.runsStatuses, value, checked);
            void props.onRunsFiltersChange({ cronRunsStatuses: next });
          }}
          onClear={() => {
            void props.onRunsFiltersChange({ cronRunsStatuses: [] });
          }}
        />
        <FilterDropdown
          id="delivery"
          title={t("cron.runs.delivery")}
          allLabel={t("cron.runs.allDelivery")}
          options={Array.from(RUN_DELIVERY_LABELS, ([value, key]) => ({
            value,
            label: t(key),
          }))}
          selected={props.runsDeliveryStatuses}
          onToggle={(value, checked) => {
            const next = toggleSelection(props.runsDeliveryStatuses, value, checked);
            void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: next });
          }}
          onClear={() => {
            void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: [] });
          }}
        />
        <div class="cron-filter-dropdown">
          <wa-dropdown
            class="cron-filter-dropdown__details"
            placement="bottom-start"
            onWa-select={(
              event: CustomEvent<{
                item: {
                  value?: string;
                };
              }>,
            ) => {
              const value = event.detail.item.value;
              if (value === "asc" || value === "desc") {
                void props.onRunsFiltersChange({ cronRunsSortDir: value });
              }
            }}
          >
            <button
              slot="trigger"
              type="button"
              class="btn btn--sm cron-filter-dropdown__trigger cron-run-sort"
              aria-label={`${t("cron.jobs.sort")} ${sortLabel()}`}
            >
              <span>{sortLabel()}</span>
              <Icon name="chevronDown" />
            </button>
            <wa-dropdown-item
              value="desc"
              aria-current={props.runsSortDir === "desc" ? "true" : "false"}
            >
              {t("cron.runs.newestFirst")}
              <span slot="details" aria-hidden="true">
                {props.runsSortDir === "desc" ? <Icon name="check" /> : undefined}
              </span>
            </wa-dropdown-item>
            <wa-dropdown-item
              value="asc"
              aria-current={props.runsSortDir === "asc" ? "true" : "false"}
            >
              {t("cron.runs.oldestFirst")}
              <span slot="details" aria-hidden="true">
                {props.runsSortDir === "asc" ? <Icon name="check" /> : undefined}
              </span>
            </wa-dropdown-item>
          </wa-dropdown>
        </div>
      </div>
      {props.runsState === "failed" ? (
        <button class="btn btn--sm" onClick={() => props.onRefresh()}>
          {t("common.retry")}
        </button>
      ) : undefined}
      {runs().length === 0 ? (
        props.runsState === "pending" ? (
          <div
            class="cron-empty-state"
            role="status"
            aria-live="polite"
            data-test-id="cron-runs-loading"
          >
            {t("cron.list.loading")}
          </div>
        ) : props.runsState !== "ready" ? undefined : hasRunFilters() ? (
          <div class="muted cron-runs__empty">{t("cron.runs.noMatching")}</div>
        ) : (
          <div class="cron-empty-state">
            <div class="cron-empty-state__title">
              {props.conditionActivity
                ? t("cron.runs.emptyConditionTitle")
                : t("cron.runs.emptyTitle")}
            </div>
            <div class="cron-empty-state__copy">
              {props.conditionActivity
                ? conditionEmptyHint(props.conditionActivity)
                : t("cron.runs.emptyHint")}
            </div>
          </div>
        )
      ) : (
        <div class="cron-runs__list">
          <For each={runs()} keyed={(entry) => `${entry.jobId}:${entry.ts}:${entry.runId ?? ""}`}>
            {(entry) => (
              <Run
                entry={entry()}
                formatTimestamp={formatTimestamp()}
                highlightedRunId={props.highlightedRunId}
                onViewRunTranscript={(targetEntry, trigger) =>
                  props.onViewRunTranscript?.(targetEntry, trigger)
                }
              />
            )}
          </For>
        </div>
      )}
      {props.runsHasMore ? (
        <button
          class="btn btn--sm cron-load-more"
          disabled={props.runsLoadingMore}
          onClick={() => props.onLoadMoreRuns()}
        >
          {props.runsLoadingMore ? t("cron.list.loading") : t("cron.runs.loadMore")}
        </button>
      ) : undefined}
    </div>
  );
}
function formatRunNextLabel(nextRunAtMs: number, nowMs = Date.now()) {
  const rel = formatRelativeTimestamp(nextRunAtMs);
  return nextRunAtMs > nowMs ? t("cron.runEntry.next", { rel }) : t("cron.runEntry.due", { rel });
}
export function runStatusLabel(
  value: string,
  completion?: CronRunLogEntry["completionStatus"],
): string {
  if (value === "ok" && (completion === "failed" || completion === "unknown")) {
    const completionLabel = t(
      completion === "failed" ? "cron.runs.runStatusError" : "cron.runs.runStatusUnknown",
    );
    return `${t("cron.runs.runStatusOk")} · ${completionLabel}`;
  }
  return t(
    Array.from(RUN_STATUS_LABELS).find(([status]) => status === value)?.[1] ??
      "cron.runs.runStatusUnknown",
  );
}
function RunError(props: { error: CronRunLogEntry["error"] }) {
  return <div class="muted">{formatUiExternalText(props.error)}</div>;
}
function Run(props: {
  entry: CronRunLogEntry;
  formatTimestamp: ReturnType<typeof createMsFormatter>;
  highlightedRunId?: string | null;
  onViewRunTranscript?: CronProps["onViewRunTranscript"];
}) {
  const status = () =>
    runStatusLabel(props.entry.status ?? "unknown", props.entry.completionStatus);
  const delivery = () =>
    t(
      RUN_DELIVERY_LABELS.get(props.entry.deliveryStatus ?? "not-requested") ??
        "cron.runs.deliveryUnknown",
    );
  const usageSummary = createMemo(() => {
    const usage = props.entry.usage;
    return usage && typeof usage.total_tokens === "number"
      ? `${formatCompactTokenCount(usage.total_tokens)} ${t("usage.metrics.tokens")}`
      : usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? `${formatCompactTokenCount(usage.input_tokens)} in / ${formatCompactTokenCount(usage.output_tokens)} out`
        : null;
  });
  const bodySource = () =>
    props.entry.summary || formatUiExternalText(props.entry.error) || t("cron.runEntry.noSummary");
  const showErrorInMeta = () => Boolean(props.entry.error) && Boolean(props.entry.summary);
  const suppressionReason = () => formatUiExternalText(props.entry.deliverySuppressionReason);
  const facts = createMemo(() =>
    [
      delivery(),
      suppressionReason()
        ? t("cron.runEntry.deliverySuppression", { reason: suppressionReason() })
        : null,
      props.entry.model,
      props.entry.provider,
      usageSummary(),
    ].filter(Boolean),
  );
  const highlighted = () =>
    Boolean(props.highlightedRunId && cronRunEntryMatchesLink(props.highlightedRunId, props.entry));
  return (
    <div class={["cron-run-entry", { "cron-run-entry--highlighted": highlighted() }]}>
      <div class="cron-run-entry__header">
        <div class="cron-run-entry__main">
          <div class="cron-run-entry__title">
            {props.entry.jobName ?? props.entry.jobId}
            <span class="muted"> · {status()}</span>
          </div>
          <div class="cron-run-entry__facts muted">{facts().join(" · ")}</div>
        </div>
        <div class="cron-run-entry__meta">
          <div>{props.formatTimestamp(props.entry.ts)}</div>
          {typeof props.entry.runAtMs === "number" ? (
            <div class="muted">
              {t("cron.runEntry.runAt")} {props.formatTimestamp(props.entry.runAtMs)}
            </div>
          ) : undefined}
          <div class="muted">
            {typeof props.entry.durationMs === "number" && Number.isFinite(props.entry.durationMs)
              ? (formatDurationCompact(props.entry.durationMs) ??
                formatDurationHuman(props.entry.durationMs, t("common.na")))
              : t("common.na")}
          </div>
          {typeof props.entry.nextRunAtMs === "number" ? (
            <div class="muted">{formatRunNextLabel(props.entry.nextRunAtMs)}</div>
          ) : undefined}
          {props.entry.runId || props.entry.runAtMs !== undefined || props.entry.sessionKey ? (
            <div>
              <button
                class="btn btn--sm"
                onClick={(event: MouseEvent) => {
                  if (event.currentTarget instanceof HTMLButtonElement) {
                    props.onViewRunTranscript?.(props.entry, event.currentTarget);
                  }
                }}
              >
                {t("cron.runEntry.viewTranscript")}
              </button>
            </div>
          ) : undefined}
          {showErrorInMeta() ? <RunError error={props.entry.error} /> : undefined}
          {props.entry.deliveryError ? <RunError error={props.entry.deliveryError} /> : undefined}
        </div>
      </div>
      <SanitizedHtml
        tag="div"
        class="cron-run-entry__body chat-text"
        html={toSanitizedMarkdownHtml(bodySource())}
      />
    </div>
  );
}
