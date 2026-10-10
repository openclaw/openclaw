import { createMemo } from "solid-js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import type { CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { AdminRequired, ErrorBanner, EnabledSwitch, JobMenu, CronTabs } from "./view-controls.tsx";
import { Editor } from "./view-editor.tsx";
import { TriggerIndicator } from "./view-job-status.tsx";
import { RunsSection } from "./view-runs.tsx";
import type { CronProps, CronPanelMode } from "./view-types.ts";
export function DetailView(componentProps: { props: CronProps; mode: CronPanelMode }) {
  // Status refresh updates the selected job's runtime facts in place.
  const selectedJob = createMemo(
    () =>
      componentProps.mode === "job" ? (componentProps.props.editingJob ?? undefined) : undefined,
    { equals: false },
  );
  const hasDetailTabs = createMemo(() => componentProps.mode === "job" && Boolean(selectedJob()));
  const showHistory = createMemo(
    () => componentProps.mode === "job" && componentProps.props.detailTab === "history",
  );
  const conditionActivity = createMemo(() => {
    const job = selectedJob();
    return job?.trigger
      ? {
          checkCount: job.state?.triggerEvalCount ?? 0,
          lastCheckedAtMs: job.state?.lastTriggerEvalAtMs,
          lastFiredAtMs: job.state?.lastTriggerFireAtMs,
        }
      : undefined;
  });
  const children = createMemo(() => [
    <div class="cron-back-row">
      <button
        type="button"
        class="cron-back"
        data-test-id="cron-back"
        disabled={componentProps.props.busy}
        onClick={() => componentProps.props.onClosePanel()}
      >
        <Icon name="arrowLeft" /> {t("cron.detail.back")}
      </button>
    </div>,
    <DetailHeader
      props={componentProps.props}
      mode={componentProps.mode}
      selectedJob={selectedJob()}
    />,
    <AdminRequired {...componentProps.props} />,
    hasDetailTabs() ? <DetailTabs {...componentProps.props} /> : undefined,
    <ErrorBanner error={componentProps.props.error} />,
    <div
      id="cron-detail-panel"
      class="cron-tab-panel"
      role={hasDetailTabs() ? "tabpanel" : undefined}
      aria-labelledby={
        hasDetailTabs() ? `cron-detail-tab-${componentProps.props.detailTab}` : undefined
      }
    >
      {showHistory() ? (
        <SettingsSection
          title={t("cron.detail.historyTitle")}
          children={
            <div class="cron-history">
              <RunsSection
                {...{ ...componentProps.props, conditionActivity: conditionActivity() }}
              />
            </div>
          }
        />
      ) : (
        <Editor props={componentProps.props} mode={componentProps.mode} />
      )}
    </div>,
  ]);
  return (
    <section class="cron-page cron-page--detail" data-panel-mode={componentProps.mode}>
      <SettingsPage children={children()} wide={true} />
    </section>
  );
}
function DetailHeader(componentProps: {
  props: CronProps;
  mode: CronPanelMode;
  selectedJob?: CronJob;
}) {
  const title = createMemo(() =>
    componentProps.mode === "job"
      ? (componentProps.selectedJob?.displayName ??
        componentProps.selectedJob?.name ??
        componentProps.props.form.name)
      : t("cron.detail.newTitle"),
  );
  const description = createMemo(() =>
    componentProps.mode === "job" ? componentProps.selectedJob?.description?.trim() : undefined,
  );
  const systemOwned = createMemo(() =>
    isSystemMonitorDeclaration(componentProps.selectedJob?.declarationKey),
  );
  // Header describes the SAVED job (schedule + next run); the form's live
  // summary describes unsaved edits, so the two never contradict each other.
  const nextRunAtMs = createMemo(() => componentProps.selectedJob?.state?.nextRunAtMs);
  const nextRunSuffix = createMemo(() =>
    typeof nextRunAtMs() === "number" && Number.isFinite(nextRunAtMs())
      ? ` · ${t("cron.jobState.next")} ${formatRelativeTimestamp(nextRunAtMs())}`
      : "",
  );
  const subtitle = createMemo(() =>
    componentProps.mode === "job" && componentProps.selectedJob
      ? `${formatCronSchedule(componentProps.selectedJob)}${nextRunSuffix()}`
      : t("cron.detail.newSubtitle"),
  );
  return (
    <div class="cron-detail-header">
      <div class="cron-detail-header__copy">
        <div class="cron-detail-title">{title()}</div>
        {description() ? (
          <div class="cron-detail-description" data-test-id="cron-detail-description">
            <span class="cron-detail-description__label">{t("cron.form.description")}:</span>
            {description()}
          </div>
        ) : undefined}
        <div class="cron-detail-meta">
          {componentProps.mode === "job" &&
          componentProps.selectedJob &&
          componentProps.props.canManage &&
          !systemOwned() ? (
            <EnabledSwitch props={componentProps.props} job={componentProps.selectedJob} />
          ) : undefined}
          <span class="cron-detail-sub">{subtitle()}</span>
          {componentProps.selectedJob?.trigger ? <TriggerIndicator /> : undefined}
        </div>
      </div>
      <div class="cron-detail-actions">
        {componentProps.mode === "job" &&
        componentProps.selectedJob &&
        componentProps.props.canManage ? (
          <>
            <button
              type="button"
              class="btn btn--sm"
              data-test-id="cron-run-now"
              disabled={componentProps.props.busy}
              onClick={() => {
                const job = componentProps.selectedJob;
                if (job) {
                  componentProps.props.onRun(job, "force");
                }
              }}
            >
              <Icon name="play" /> {t("cron.actions.runNow")}
            </button>
            <JobMenu props={componentProps.props} job={componentProps.selectedJob} />
          </>
        ) : undefined}
      </div>
    </div>
  );
}
function DetailTabs(props: CronProps) {
  return (
    <CronTabs
      props={{
        id: "cron-detail",
        panelId: "cron-detail-panel",
        className: "cron-tabs",
        variant: "sub",
        active: props.detailTab,
        tabs: [
          {
            value: "settings",
            label: t("cron.detail.settingsTab"),
            testId: "cron-detail-tab-settings",
          },
          {
            value: "history",
            label: t("cron.detail.historyTitle"),
            testId: "cron-detail-tab-history",
          },
        ],
        ariaLabel: t("cron.detail.tabsLabel"),
        onSelect: props.onDetailTabChange,
      }}
    />
  );
}
