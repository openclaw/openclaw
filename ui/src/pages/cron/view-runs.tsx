import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { createMemo, createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { cronRunEntryMatchesLink } from "../../../../src/cron/run-link.js";
import type { CronRunLogEntry, CronDeliveryStatus, CronRunsStatusValue } from "../../api/types.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { iconButtonClass } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { SettingsSectionHeader } from "../../components/solid/settings-ui.tsx";
import { i18n } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { formatDurationCompact, formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  formatRelativeTimestamp,
  createCompactMsFormatter,
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
  | "onRunMount"
  | "onRetryRun"
> & {
  busy?: boolean;
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
  const selectedLabels = () =>
    props.options
      .filter((option) => props.selected.includes(option.value))
      .map((option) => option.label);
  const summary = () =>
    selectedLabels().length === 0
      ? props.allLabel
      : selectedLabels().length <= 2
        ? selectedLabels().join(", ")
        : `${selectedLabels()[0]} +${selectedLabels().length - 1}`;
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
      <Menu
        id={`cron-runs-filter-${props.id}`}
        label={`${props.title} ${accessibleSummary()}`}
        class="cron-filter-dropdown__details"
        triggerClass={[
          "btn btn--sm cron-filter-dropdown__trigger",
          { active: props.selected.length > 0 },
        ]}
        triggerAttributes={{ title: props.title }}
        trigger={
          <>
            <span>{summary()}</span>
            <Icon name="chevronDown" />
          </>
        }
        placement="bottom-start"
        items={[
          ...props.options.map((option) => ({
            id: `${FILTER_OPTION_PREFIX}${option.value}`,
            label: option.label,
            class: "cron-filter-dropdown__option",
            type: "checkbox" as const,
            checked: props.selected.includes(option.value),
            closeOnSelect: false,
          })),
          {
            kind: "content",
            id: "separator",
            content: <div class="session-menu__separator" role="separator" />,
          },
          {
            id: `${FILTER_COMMAND_PREFIX}clear`,
            label: t("cron.runs.clear"),
            class: "cron-filter-dropdown__clear",
          },
        ]}
        onSelect={(item) => {
          if (item.id === `${FILTER_COMMAND_PREFIX}clear`) {
            props.onClear();
          } else if (item.id.startsWith(FILTER_OPTION_PREFIX)) {
            const option = props.options.find(
              (candidate) => candidate.value === item.id.slice(FILTER_OPTION_PREFIX.length),
            );
            if (option) {
              props.onToggle(option.value, !props.selected.includes(option.value));
            }
          }
        }}
      />
    </div>
  );
}
/** True when a run filter or the sort differs from the default view. */
function hasActiveRunFilters(filters: CronRunsSectionProps) {
  return (
    filters.runsQuery.trim().length > 0 ||
    filters.runsStatuses.length > 0 ||
    filters.runsDeliveryStatuses.length > 0 ||
    filters.runsSortDir === "asc"
  );
}
/** A titled run list whose filters sit behind one button beside the heading. */
export function RunHistory(
  props: CronRunsSectionProps & {
    title: string;
    showJobName?: boolean;
  },
) {
  const filtersId = createUniqueId();
  // Filters already narrowing the list stay in view; otherwise the heading carries one button.
  const [filtersOpen, setFiltersOpen] = createSignal(hasActiveRunFilters(props));
  return (
    <section class="settings-section cron-history">
      <SettingsSectionHeader
        title={props.title}
        actions={
          <button
            type="button"
            class={iconButtonClass({ size: 28, glyph: "row" })}
            data-test-id="cron-runs-filters-toggle"
            aria-label={t("cron.list.filters")}
            title={t("cron.list.filters")}
            aria-expanded={filtersOpen() ? "true" : "false"}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <Icon name="listFilter" />
          </button>
        }
      />
      <RunsSection {...props} filtersId={filtersId} filtersOpen={filtersOpen()} />
    </section>
  );
}
export function RunsSection(
  props: CronRunsSectionProps & {
    showJobName?: boolean;
    filtersId?: string;
    filtersOpen?: boolean;
  },
) {
  const formatTimestamp = createMemo(() => createCompactMsFormatter(undefined, t("common.na")));
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
            onClick={() => props.onRunsFiltersChange({ cronRunsRunId: null })}
          >
            {t("cron.linkedRun.showAll")}
          </button>
        </div>
      ) : undefined}
      <div id={props.filtersId} class="cron-run-filters" hidden={props.filtersOpen === false}>
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
              props.onRunsFiltersChange({
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
            props.onRunsFiltersChange({ cronRunsStatuses: next });
          }}
          onClear={() => {
            props.onRunsFiltersChange({ cronRunsStatuses: [] });
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
            props.onRunsFiltersChange({ cronRunsDeliveryStatuses: next });
          }}
          onClear={() => {
            props.onRunsFiltersChange({ cronRunsDeliveryStatuses: [] });
          }}
        />
        <div class="cron-filter-dropdown">
          <Menu
            id="cron-runs-sort"
            label={`${t("cron.jobs.sort")} ${sortLabel()}`}
            class="cron-filter-dropdown__details"
            triggerClass="btn btn--sm cron-filter-dropdown__trigger cron-run-sort"
            trigger={
              <>
                <span>{sortLabel()}</span>
                <Icon name="chevronDown" />
              </>
            }
            placement="bottom-start"
            items={[
              {
                id: "desc",
                label: t("cron.runs.newestFirst"),
                attributes: { "aria-current": props.runsSortDir === "desc" ? "true" : "false" },
                details: (
                  <span aria-hidden="true">
                    {props.runsSortDir === "desc" ? <Icon name="check" /> : undefined}
                  </span>
                ),
              },
              {
                id: "asc",
                label: t("cron.runs.oldestFirst"),
                attributes: { "aria-current": props.runsSortDir === "asc" ? "true" : "false" },
                details: (
                  <span aria-hidden="true">
                    {props.runsSortDir === "asc" ? <Icon name="check" /> : undefined}
                  </span>
                ),
              },
            ]}
            onSelect={(item) => {
              if (item.id === "asc" || item.id === "desc") {
                props.onRunsFiltersChange({ cronRunsSortDir: item.id });
              }
            }}
          />
        </div>
      </div>
      {props.runsState === "failed" ? (
        <button class="btn btn--sm" onClick={() => void props.onRefresh()}>
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
            {t("cron.runs.loading")}
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
                showJobName={props.showJobName}
                onRunMount={(element, getEntry) => props.onRunMount?.(element, getEntry)}
                onRetryRun={props.onRetryRun}
                busy={props.busy}
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
          {props.runsLoadingMore ? t("cron.runs.loading") : t("cron.runs.loadMore")}
        </button>
      ) : undefined}
    </div>
  );
}
function runStatusLabel(value: string, completion?: CronRunLogEntry["completionStatus"]): string {
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
/** Long errors stay two lines tall until the reader asks for the rest. */
const RUN_ERROR_PREVIEW_CHARS = 160;
function RunError(props: { error: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const long = () => props.error.length > RUN_ERROR_PREVIEW_CHARS || props.error.includes("\n");
  return (
    <div class="cron-run-entry__error">
      <div class={["muted", { "cron-error--clamped": long() && !expanded() }]} title={props.error}>
        {props.error}
      </div>
      <Show when={long()}>
        <button
          type="button"
          class="settings-row__desc-action"
          aria-expanded={expanded() ? "true" : "false"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded() ? t("cron.runEntry.hideDetails") : t("cron.runEntry.showDetails")}
        </button>
      </Show>
    </div>
  );
}
/** The dot beside a run's status: success, failure, or neither. */
function runTone(entry: CronRunLogEntry, conditionFailed: boolean): "ok" | "danger" | "muted" {
  if (conditionFailed || entry.status === "error") {
    return "danger";
  }
  return entry.status === "ok" && entry.completionStatus !== "failed" ? "ok" : "muted";
}
function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element && target.closest("a, button, summary, input, textarea") !== null
  );
}
function Run(props: {
  entry: CronRunLogEntry;
  formatTimestamp: ReturnType<typeof createCompactMsFormatter>;
  highlightedRunId?: string | null;
  showJobName?: boolean;
  busy?: boolean;
  onRetryRun?: CronProps["onRetryRun"];
  onRunMount?: (
    ...args: Parameters<NonNullable<CronProps["onRunMount"]>>
  ) => (() => void) | undefined;
}) {
  const detailsId = createUniqueId();
  // A failed run whose condition never fired is a condition-script failure: no task ran.
  const conditionFailed = () =>
    props.entry.status === "error" && props.entry.triggerFired === false;
  const status = () =>
    conditionFailed()
      ? t("cron.runEntry.conditionCheckFailed")
      : runStatusLabel(props.entry.status ?? "unknown", props.entry.completionStatus);
  // An unknown outcome is not a fact worth showing.
  const delivery = () => {
    const deliveryStatus = props.entry.deliveryStatus ?? "not-requested";
    const label = RUN_DELIVERY_LABELS.get(deliveryStatus);
    // An unknown outcome is only worth a label when it carries its own explanation.
    return !label || (deliveryStatus === "unknown" && !deliveryError()) ? null : t(label);
  };
  const usageSummary = createMemo(() => {
    const usage = props.entry.usage;
    return usage?.total_tokens !== undefined
      ? t("cron.runEntry.tokens", { count: formatCompactTokenCount(usage.total_tokens) })
      : usage?.input_tokens !== undefined && usage.output_tokens !== undefined
        ? t("cron.runEntry.inputOutputTokens", {
            input: formatCompactTokenCount(usage.input_tokens),
            output: formatCompactTokenCount(usage.output_tokens),
          })
        : null;
  });
  const duration = () =>
    props.entry.durationMs !== undefined
      ? (formatDurationCompact(props.entry.durationMs) ??
        formatDurationHuman(props.entry.durationMs, t("common.na")))
      : null;
  const error = () => formatUiExternalText(props.entry.error);
  // Older history copied the run error into the delivery error; show each error once.
  const deliveryError = () => {
    const text = formatUiExternalText(props.entry.deliveryError);
    return text === error() ? "" : text;
  };
  const suppressionReason = () => formatUiExternalText(props.entry.deliverySuppressionReason);
  const facts = createMemo(() =>
    [
      duration(),
      delivery(),
      suppressionReason()
        ? t("cron.runEntry.deliverySuppression", { reason: suppressionReason() })
        : null,
      props.entry.model,
      props.entry.provider,
      usageSummary(),
    ].filter(Boolean),
  );
  const highlighted = createMemo(() =>
    props.highlightedRunId && cronRunEntryMatchesLink(props.highlightedRunId, props.entry)
      ? props.highlightedRunId
      : null,
  );
  // A linked run starts open unless the reader has chosen its disclosure state.
  const [userExpanded, setUserExpanded] = createSignal<boolean>();
  const expanded = () => userExpanded() ?? Boolean(highlighted());
  const toggle = () => setUserExpanded(!expanded());
  let row!: HTMLDivElement;
  onSettled(() => props.onRunMount?.(row, () => props.entry));
  return (
    <div
      ref={(element) => {
        row = element;
      }}
      class={[
        "cron-run-entry",
        {
          "cron-run-entry--highlighted": Boolean(highlighted()),
          "cron-run-entry--expanded": expanded(),
        },
      ]}
      data-tone={runTone(props.entry, conditionFailed())}
      onClick={(event) => {
        // The block opens on a click, but links, buttons and text selections keep their own job.
        if (
          event.currentTarget !== event.target &&
          (isInteractiveTarget(event.target) || Boolean(window.getSelection()?.toString()))
        ) {
          return;
        }
        toggle();
      }}
    >
      <button
        type="button"
        class="cron-run-entry__header"
        aria-expanded={expanded() ? "true" : "false"}
        aria-controls={detailsId}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        <span class="cron-run-entry__dot" aria-hidden="true" />
        <span class="cron-run-entry__title">
          {props.showJobName ? (
            <>
              <span class="cron-run-entry__job">{props.entry.jobName ?? props.entry.jobId}</span>
              {" · "}
            </>
          ) : undefined}
          <span class="cron-run-entry__status">{status()}</span>
        </span>
        <span class="cron-run-entry__facts">{facts().join(" · ")}</span>
        <span class="cron-run-entry__time">{props.formatTimestamp(props.entry.ts)}</span>
      </button>
      <Show
        when={props.entry.summary || !error()}
        fallback={
          <div class="cron-run-entry__body">
            <RunError error={error()} />
          </div>
        }
      >
        <Show
          when={expanded()}
          fallback={
            <div
              class={[
                "cron-run-entry__body cron-run-entry__summary",
                { "cron-run-entry__summary--empty": !props.entry.summary },
              ]}
            >
              {props.entry.summary
                ? flattenMarkdownToPlainText(props.entry.summary)
                : t("cron.runEntry.noSummary")}
            </div>
          }
        >
          <SanitizedHtml
            tag="div"
            class={[
              "cron-run-entry__body cron-run-entry__summary chat-text",
              { "cron-run-entry__summary--empty": !props.entry.summary },
            ]}
            html={toSanitizedMarkdownHtml(props.entry.summary || t("cron.runEntry.noSummary"))}
          />
        </Show>
        <Show when={error()}>
          <RunError error={error()} />
        </Show>
      </Show>
      <Show when={props.entry.runId && props.entry.retryAvailable && Boolean(props.onRetryRun)}>
        <div class="cron-run-entry__body">
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.busy}
            title={t("cron.runEntry.retryHelp")}
            onClick={() => props.onRetryRun?.(props.entry)}
          >
            {t("common.retry")}
          </button>
        </div>
      </Show>
      <div id={detailsId} class="cron-run-entry__details" hidden={!expanded()}>
        {props.entry.runAtMs !== undefined || props.entry.nextRunAtMs !== undefined ? (
          <div class="cron-run-entry__meta">
            {props.entry.runAtMs !== undefined ? (
              <span>
                {t("cron.runEntry.runAt")} {props.formatTimestamp(props.entry.runAtMs)}
              </span>
            ) : undefined}
            {props.entry.nextRunAtMs !== undefined ? (
              <span>
                {t("cron.runEntry.next", { rel: props.formatTimestamp(props.entry.nextRunAtMs) })}
              </span>
            ) : undefined}
          </div>
        ) : undefined}
        <Show when={deliveryError()}>
          <div class="cron-run-entry__delivery-error">
            {t(
              props.entry.deliveryStatus === "not-delivered"
                ? "cron.runEntry.deliveryFailed"
                : "cron.runEntry.deliveryNote",
              { error: deliveryError() },
            )}
          </div>
        </Show>
      </div>
    </div>
  );
}
