import { createMemo } from "solid-js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import type { CronJob } from "../../api/types.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { AdminRequired, ErrorBanner, EnabledSwitch, JobMenu } from "./view-controls.tsx";
import { Editor } from "./view-editor.tsx";
import { TriggerIndicator } from "./view-job-status.tsx";
import { RunsSection } from "./view-runs.tsx";
import type { CronProps, CronPanelMode } from "./view-types.ts";
export function DetailView(
  props: CronProps & {
    mode: CronPanelMode;
  },
) {
  // Status refresh updates the selected job's runtime facts in place.
  const selectedJob = createMemo(
    () => (props.mode === "job" ? (props.editingJob ?? undefined) : undefined),
    { equals: false },
  );
  const hasDetailTabs = () => props.mode === "job" && Boolean(selectedJob());
  const showHistory = () => props.mode === "job" && props.detailTab === "history";
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
  return (
    <section class="cron-page cron-page--detail" data-panel-mode={props.mode}>
      <SettingsPage wide>
        <div class="cron-back-row">
          <button
            type="button"
            class="cron-back"
            data-test-id="cron-back"
            disabled={props.busy}
            onClick={() => props.onClosePanel()}
          >
            <Icon name="arrowLeft" /> {t("cron.detail.back")}
          </button>
        </div>
        <DetailHeader {...props} mode={props.mode} selectedJob={selectedJob()} />
        <AdminRequired {...props} />
        {hasDetailTabs() ? <DetailTabs {...props} /> : undefined}
        <ErrorBanner error={props.error} />
        <div
          id="cron-detail-panel"
          class="cron-tab-panel"
          role={hasDetailTabs() ? "tabpanel" : undefined}
          aria-labelledby={hasDetailTabs() ? `cron-detail-tab-${props.detailTab}` : undefined}
        >
          {showHistory() ? (
            <SettingsSection title={t("cron.detail.historyTitle")}>
              <div class="cron-history">
                <RunsSection {...{ ...props, conditionActivity: conditionActivity() }} />
              </div>
            </SettingsSection>
          ) : (
            <Editor {...props} mode={props.mode} />
          )}
        </div>
      </SettingsPage>
    </section>
  );
}
function DetailHeader(
  props: CronProps & {
    mode: CronPanelMode;
    selectedJob?: CronJob;
  },
) {
  const title = () =>
    props.mode === "job"
      ? (props.selectedJob?.displayName ?? props.selectedJob?.name ?? props.form.name)
      : t("cron.detail.newTitle");
  const description = () =>
    props.mode === "job" ? props.selectedJob?.description?.trim() : undefined;
  const systemOwned = () => isSystemMonitorDeclaration(props.selectedJob?.declarationKey);
  // Header describes the SAVED job (schedule + next run); the form's live
  // summary describes unsaved edits, so the two never contradict each other.
  const nextRunAtMs = () => props.selectedJob?.state?.nextRunAtMs;
  const nextRunSuffix = () =>
    typeof nextRunAtMs() === "number" && Number.isFinite(nextRunAtMs())
      ? ` · ${t("cron.jobState.next")} ${formatRelativeTimestamp(nextRunAtMs())}`
      : "";
  const subtitle = () =>
    props.mode === "job" && props.selectedJob
      ? `${formatCronSchedule(props.selectedJob)}${nextRunSuffix()}`
      : t("cron.detail.newSubtitle");
  return (
    <div class="cron-detail-header">
      <div class="cron-detail-header__copy">
        <div class="cron-detail-title">{title()}</div>
        {description() ? (
          <div class="cron-detail-description" data-test-id="cron-detail-description">
            <span class="cron-detail-description__label">{t("cron.form.description")}:</span>{" "}
            {description()}
          </div>
        ) : undefined}
        <div class="cron-detail-meta">
          {props.mode === "job" && props.selectedJob && props.canManage && !systemOwned() ? (
            <EnabledSwitch {...props} job={props.selectedJob} />
          ) : undefined}
          <span class="cron-detail-sub">{subtitle()}</span>
          {props.selectedJob?.trigger ? <TriggerIndicator /> : undefined}
        </div>
      </div>
      <div class="cron-detail-actions">
        {props.mode === "job" && props.selectedJob && props.canManage ? (
          <>
            <button
              type="button"
              class="btn btn--sm"
              data-test-id="cron-run-now"
              disabled={props.busy}
              onClick={() => {
                const job = props.selectedJob;
                if (job) {
                  props.onRun(job, "force");
                }
              }}
            >
              <Icon name="play" /> {t("cron.actions.runNow")}
            </button>
            <JobMenu {...props} job={props.selectedJob} />
          </>
        ) : undefined}
      </div>
    </div>
  );
}
function DetailTabs(props: CronProps) {
  return (
    <LitContent
      render={() =>
        renderHubTabs({
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
        })
      }
    />
  );
}
