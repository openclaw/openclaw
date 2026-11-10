import { createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";
import { formatRelativeTimestamp, createCompactMsFormatter } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { RunFilters } from "./view-run-filters.tsx";
import { RunRows } from "./view-run-rows.tsx";
import type { CronProps } from "./view-types.ts";
export { runStatusLabel } from "./view-run-status.ts";
registerEnglishCatalog(registerCronEnglish);
export type CronRunsSectionProps = Pick<
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
  | "onRunMount"
> &
  Partial<
    Pick<
      CronProps,
      "phoneLayout" | "showAgent" | "jobs" | "canManage" | "canCreate" | "onOpenCreate" | "focus"
    >
  > & {
    overview?: boolean;
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
export function RunsSection(props: CronRunsSectionProps) {
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
      {!props.overview || props.phoneLayout ? <RunFilters {...props} /> : undefined}
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
        <RunRows {...props} rows={runs()} formatTimestamp={formatTimestamp()} />
      )}
      {props.runsLoadingMore ? (
        <div
          class="cron-jobs-loading-more cron-runs-loading-more"
          role="status"
          aria-label={t("cron.runs.loading")}
          data-test-id="cron-runs-loading-more"
        >
          <span class="btn__spinner" aria-hidden="true" />
        </div>
      ) : undefined}
    </div>
  );
}
