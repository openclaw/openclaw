import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import type { CronJobsEnabledFilter, CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { isCronJobActiveFailure, isCronJobRunning } from "../../lib/cron-status.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { CRON_SUGGESTIONS, suggestionFormPatch } from "./suggestions.ts";
import {
  AdminRequired,
  ErrorBanner,
  CronTabs,
  CronJobsPagination,
  EnabledSwitch,
  JobMenu,
} from "./view-controls.tsx";
import {
  JobStateIndicator,
  TriggerIndicator,
  DisabledNote,
  LastRunCell,
} from "./view-job-status.tsx";
import { JobsFilterPopover } from "./view-jobs-filter.tsx";
import { RunsSection } from "./view-runs.tsx";
import type { CronProps } from "./view-types.ts";
const ENABLED_TABS: Array<{
  value: CronJobsEnabledFilter;
  labelKey: string;
}> = [
  { value: "all", labelKey: "cron.tabs.all" },
  { value: "enabled", labelKey: "cron.tabs.active" },
  { value: "disabled", labelKey: "cron.tabs.paused" },
];
export function ListView(props: CronProps) {
  const hasAdvancedJobsFilters = createMemo(
    () =>
      props.jobsScheduleKindFilter !== "all" ||
      props.jobsLastStatusFilter !== "all" ||
      props.jobsTriggerFilter !== "all" ||
      props.jobsSortBy !== "nextRunAtMs" ||
      props.jobsSortDir !== "asc",
  );
  const hasAnyJobsFilters = createMemo(
    () =>
      hasAdvancedJobsFilters() ||
      props.jobsQuery.trim().length > 0 ||
      props.jobsEnabledFilter !== "all",
  );
  const showStarterAutomations = createMemo(
    () =>
      !props.loading &&
      props.hasLoaded &&
      !props.listError &&
      !props.error &&
      props.jobsTotal === 0 &&
      !hasAnyJobsFilters() &&
      props.canManage,
  );
  const children = createMemo(() => [
    <div class="cron-overview-header">
      <AdminRequired {...props} />
      {props.status && !props.status.enabled ? (
        <div class="cron-error-banner" data-test-id="cron-scheduler-banner">
          <strong>{t("cron.list.schedulerOff")}</strong>
          {t("cron.runNotStarted.stopped")}
        </div>
      ) : undefined}
      <ErrorBanner error={props.listError} /> <ErrorBanner error={props.error} />
      <Toolbar props={props} hasAdvancedJobsFilters={hasAdvancedJobsFilters()} />
    </div>,
    <div
      id="cron-list-panel"
      class="cron-tab-panel"
      role="tabpanel"
      aria-labelledby={`cron-list-tab-${props.listTab === "activity" ? "activity" : props.jobsEnabledFilter}`}
    >
      {props.listTab === "activity" ? (
        <SettingsSection
          children={
            <div class="cron-activity">
              <RunsSection {...props} />
            </div>
          }
        />
      ) : (
        [
          <SettingsSection
            children={<JobsTable props={props} hasAnyJobsFilters={hasAnyJobsFilters()} />}
          />,
          showStarterAutomations() ? <Suggestions {...props} /> : undefined,
        ]
      )}
    </div>,
  ]);
  return (
    <section class="cron-page" data-panel-mode="overview">
      <SettingsPage children={children()} wide={true} />
    </section>
  );
}
function ListTabs(props: CronProps) {
  return (
    <CronTabs
      props={{
        id: "cron-list",
        panelId: "cron-list-panel",
        className: "cron-tabs",
        active: props.listTab === "activity" ? "activity" : props.jobsEnabledFilter,
        tabs: [
          ...ENABLED_TABS.map((tab) => ({
            value: tab.value,
            label: t(tab.labelKey),
            testId: `cron-tab-${tab.value}`,
          })),
          {
            value: "activity",
            label: t("cron.list.activityTab"),
            testId: "cron-list-tab-activity",
          },
        ],
        ariaLabel: t("cron.list.viewLabel"),
        onSelect: (value) => {
          if (value === "activity") {
            props.onListTabChange("activity");
            return;
          }
          props.onListTabChange("tasks");
          if (value !== props.jobsEnabledFilter) {
            void props.onJobsFiltersChange({ cronJobsEnabledFilter: value });
          }
        },
      }}
    />
  );
}
// Search owns the full first row; navigation and list actions share the row
// immediately above the table they affect.
function Toolbar(componentProps: { props: CronProps; hasAdvancedJobsFilters: boolean }) {
  return (
    <div class="cron-toolbar">
      {componentProps.props.listTab === "tasks" ? (
        <div class="cron-toolbar__filters">
          <div class="cron-search-box">
            <span class="cron-search-box__icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              type="search"
              class="settings-input"
              prop:value={componentProps.props.jobsQuery}
              aria-label={t("cron.list.searchPlaceholder")}
              placeholder={t("cron.list.searchPlaceholder")}
              onInput={(e) =>
                void componentProps.props.onJobsFiltersChange({
                  cronJobsQuery: e.currentTarget.value,
                })
              }
            />
          </div>
          <JobsFilterPopover
            props={componentProps.props}
            active={componentProps.hasAdvancedJobsFilters}
          />
        </div>
      ) : undefined}
      <div class="cron-toolbar__primary">
        <ListTabs {...componentProps.props} />
        <div class="cron-toolbar__actions">
          <button
            type="button"
            class={[
              "btn btn--sm btn--ghost cron-refresh",
              { "cron-refresh--loading": componentProps.props.loading },
            ]}
            disabled={componentProps.props.loading}
            title={
              componentProps.props.loading ? t("cron.list.refreshing") : t("cron.list.refresh")
            }
            aria-label={t("cron.list.refresh")}
            onClick={() => componentProps.props.onRefresh()}
          >
            <Icon name="refresh" />
          </button>
          {componentProps.props.canManage ? (
            <button
              type="button"
              class="btn primary btn--sm cron-new-task"
              data-test-id="cron-new-task"
              onClick={() => componentProps.props.onOpenCreate()}
            >
              <Icon name="plus" /> {t("cron.list.newTask")}
            </button>
          ) : undefined}
        </div>
      </div>
    </div>
  );
}
function JobsTable(componentProps: { props: CronProps; hasAnyJobsFilters: boolean }) {
  // A snapshot revision is the successful-list fact. Until one exists, show
  // pending or failure, never completed-empty guidance.
  const initialPending = createMemo(
    () => componentProps.props.loading && !componentProps.props.hasLoaded,
  );
  const tableBusy = createMemo(
    () => componentProps.props.loading || componentProps.props.jobsLoadingMore,
  );
  const jobs = createMemo(() =>
    componentProps.props.jobs.toSorted(
      (left, right) => Number(isCronJobActiveFailure(right)) - Number(isCronJobActiveFailure(left)),
    ),
  );
  return (
    <div
      class={["cron-table", { "cron-table--read-only": !componentProps.props.canManage }]}
      aria-busy={tableBusy() ? "true" : undefined}
    >
      <div class="cron-table__head">
        <span>{t("cron.jobs.name")}</span>
        <span>{t("cron.jobs.schedule")}</span>
        <span>{t("cron.jobs.nextRun")}</span>
        <span>{t("cron.jobs.lastRun")}</span>
        {componentProps.props.canManage ? <span aria-hidden="true" /> : undefined}
      </div>
      {jobs().length === 0 ? (
        initialPending() ? (
          <div
            class="cron-empty-state"
            role="status"
            aria-live="polite"
            data-test-id="cron-jobs-loading"
          >
            <div class="cron-empty-state__title">{t("cron.list.loading")}</div>
          </div>
        ) : componentProps.props.hasLoaded ? (
          <div class="cron-empty-state">
            <div class="cron-empty-state__title">
              {componentProps.hasAnyJobsFilters
                ? t("cron.list.noMatching")
                : t("cron.list.emptyTitle")}
            </div>
            {componentProps.hasAnyJobsFilters ? undefined : (
              <div class="cron-empty-state__copy">{t("cron.list.emptyHint")}</div>
            )}
          </div>
        ) : undefined
      ) : (
        <For each={jobs()} keyed={(job) => job.id}>
          {(job) => <JobRow job={job()} props={componentProps.props} />}
        </For>
      )}
      <CronJobsPagination
        params={{
          jobsShown: componentProps.props.jobs.length,
          jobsTotal: componentProps.props.jobsTotal,
          hasMore: componentProps.props.jobsHasMore,
          loading: componentProps.props.loading,
          loadingMore: componentProps.props.jobsLoadingMore,
          onLoadMore: componentProps.props.onLoadMoreJobs,
        }}
      />
    </div>
  );
}
function JobRow(componentProps: { job: CronJob; props: CronProps }) {
  const displayName = createMemo(() => componentProps.job.displayName ?? componentProps.job.name);
  const description = createMemo(() => componentProps.job.description?.trim());
  const systemOwned = createMemo(() =>
    isSystemMonitorDeclaration(componentProps.job.declarationKey),
  );
  const nextRunAtMs = createMemo(() => componentProps.job.state?.nextRunAtMs);
  const hasNextRun = createMemo(
    () => typeof nextRunAtMs() === "number" && Number.isFinite(nextRunAtMs()),
  );
  const nextRun = createMemo(() =>
    isCronJobRunning(componentProps.job) ? (
      <span class="cron-table__running">{t("cron.runs.runStatusRunning")}</span>
    ) : hasNextRun() ? (
      formatRelativeTimestamp(nextRunAtMs())
    ) : (
      t("common.na")
    ),
  );
  return (
    <div
      class={["cron-table__row", { "cron-table__row--paused": !componentProps.job.enabled }]}
      data-test-id={`cron-row-${componentProps.job.id}`}
      onClick={() => componentProps.props.onSelectJob(componentProps.job)}
    >
      <button type="button" class="cron-table__name">
        <JobStateIndicator job={componentProps.job} />
        <span class="cron-table__name-copy">
          <span class="cron-table__name-line">
            <span class="cron-table__name-text">{displayName()}</span>
            {componentProps.job.trigger ? <TriggerIndicator /> : undefined}
          </span>
          {systemOwned() ? undefined : (
            <openclaw-agent-row-chip prop:agentId={componentProps.job.agentId} />
          )}
          {description() || !componentProps.job.enabled ? (
            <span class="cron-table__name-meta">
              {description() ? (
                <span
                  class="cron-table__description"
                  data-test-id={`cron-row-description-${componentProps.job.id}`}
                  title={`${t("cron.form.description")}: ${description()}`}
                >
                  {description()}
                </span>
              ) : undefined}
              {description() && !componentProps.job.enabled ? (
                <span class="cron-table__meta-separator" aria-hidden="true">
                  ·
                </span>
              ) : undefined}
              {componentProps.job.enabled ? undefined : <DisabledNote job={componentProps.job} />}
            </span>
          ) : undefined}
        </span>
      </button>
      <JobCell
        class="cron-table__schedule"
        label={t("cron.jobs.schedule")}
        value={formatCronSchedule(componentProps.job)}
      />
      <JobCell class="cron-table__next" label={t("cron.jobs.nextRun")} value={nextRun()} />
      <JobCell
        class="cron-table__last"
        label={t("cron.jobs.lastRun")}
        value={<LastRunCell job={componentProps.job} />}
      />
      {componentProps.props.canManage ? (
        <span class="cron-table__actions" onClick={(e: Event) => e.stopPropagation()}>
          <button
            type="button"
            class="btn btn--sm btn--ghost cron-row-run"
            data-test-id={`cron-row-run-${componentProps.job.id}`}
            title={t("cron.actions.runNowJob", { name: displayName() })}
            aria-label={t("cron.actions.runNowJob", { name: displayName() })}
            disabled={componentProps.props.busy}
            onClick={() => componentProps.props.onRun(componentProps.job, "force")}
          >
            <Icon name="play" />
          </button>
          {systemOwned() ? undefined : (
            <EnabledSwitch props={componentProps.props} job={componentProps.job} compact />
          )}
          <JobMenu props={componentProps.props} job={componentProps.job} />
        </span>
      ) : undefined}
    </div>
  );
}
function JobCell(componentProps: { class: string; label: string; value: JSX.Element }) {
  return (
    <span class={`cron-table__cell ${componentProps.class}`}>
      <span class="cron-table__cell-label">{componentProps.label}</span>
      <span class="cron-table__cell-value">{componentProps.value}</span>
    </span>
  );
}
function Suggestions(props: CronProps) {
  return (
    <SettingsSection
      title={t("cron.suggestions.title")}
      children={
        <For each={CRON_SUGGESTIONS}>
          {(suggestion) => (
            <button
              type="button"
              class="settings-row settings-row--nav cron-suggestion"
              data-suggestion={suggestion.id}
              onClick={() => props.onOpenCreate(suggestionFormPatch(suggestion))}
            >
              <div class="settings-row__text">
                <span class="settings-row__title">
                  <span aria-hidden="true">{suggestion.emoji}</span> {t(suggestion.nameKey)}
                </span>
                <span class="settings-row__desc">{t(suggestion.taglineKey)}</span>
              </div>
              <div class="settings-row__control">
                <span class="settings-row__value">{t(suggestion.scheduleKey)}</span>
                <span class="settings-row__chevron">
                  <Icon name="chevronRight" />
                </span>
              </div>
            </button>
          )}
        </For>
      }
    />
  );
}
