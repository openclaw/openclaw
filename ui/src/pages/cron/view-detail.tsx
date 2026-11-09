import { createMemo, Show } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import {
  cronJobNextRunFacts,
  isRecurringSchedule,
  readAutomationNextRun,
} from "../../lib/cron-next-run.ts";
import { isCronJobActiveFailure } from "../../lib/cron-status.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { FailureDetails } from "./view-attention.tsx";
import {
  AdminRequired,
  ErrorBanner,
  EnabledSwitch,
  JobMenu,
  NoticeBanner,
} from "./view-controls.tsx";
import { Editor } from "./view-editor.tsx";
import { describeJobNextRun, describeJobSchedule, TriggerIndicator } from "./view-job-status.tsx";
import { RunsSection } from "./view-runs.tsx";
import { CronSuggestionLists } from "./view-suggestions.tsx";
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
  const failedJob = () => {
    const job = selectedJob();
    return job && isCronJobActiveFailure(job) ? job : undefined;
  };
  const hasDetailTabs = () => props.mode === "job" && Boolean(selectedJob());
  const showHistory = () => props.mode === "job" && props.detailTab === "history";
  const conditionActivity = () => {
    const job = selectedJob();
    return job?.trigger
      ? {
          checkCount: job.state?.triggerEvalCount ?? 0,
          lastCheckedAtMs: job.state?.lastTriggerEvalAtMs,
          lastFiredAtMs: job.state?.lastTriggerFireAtMs,
        }
      : undefined;
  };
  return (
    <section class="cron-page cron-page--detail" data-panel-mode={props.mode}>
      <SettingsPage wide>
        <div class="cron-back-row">
          <button
            ref={props.focus?.ref("back")}
            type="button"
            class="cron-back"
            data-test-id="cron-back"
            disabled={props.busy}
            onClick={() => props.onClosePanel()}
          >
            <Icon name="arrowLeft" /> {t("cron.detail.back")}
          </button>
        </div>
        <div class="stack">
          <DetailHeader {...props} mode={props.mode} selectedJob={selectedJob()} />
          <Show when={failedJob()}>
            {(job) => (
              // History exposes the full saved-job cause without requiring a retained run.
              <FailureDetails
                job={job()}
                fullCause={showHistory()}
                onReviewRun={showHistory() ? undefined : () => props.onSelectJob(job())}
              />
            )}
          </Show>
        </div>
        <AdminRequired {...props} />
        {hasDetailTabs() ? <DetailTabs {...props} /> : undefined}
        <ErrorBanner error={props.error} reads={showHistory() ? undefined : props.reads} />
        <NoticeBanner notice={props.notice} />
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
            <>
              <Editor {...props} mode={props.mode} />
              <CronSuggestionLists {...props} />
            </>
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
  // Header describes the SAVED job's runtime; the form's live summary describes
  // unsaved edits, so the two never contradict each other.
  const savedJob = () => (props.mode === "job" ? props.selectedJob : undefined);
  // Wall-clock schedules lead with the scheduler-owned next run; cadence moves to the icon.
  const scheduleIcon = (): "repeat" | "clock" | undefined => {
    const schedule = savedJob()?.schedule;
    return !schedule
      ? undefined
      : isRecurringSchedule(schedule)
        ? "repeat"
        : schedule.kind === "at"
          ? "clock"
          : undefined;
  };
  const cadence = () => {
    const job = savedJob();
    return job && scheduleIcon() === "repeat"
      ? describeJobSchedule(job)
      : t("cron.scheduleLabel.once");
  };
  const subtitle = () => {
    const job = savedJob();
    if (!job) {
      return t("cron.detail.newSubtitle");
    }
    if (!scheduleIcon()) {
      return `${describeJobSchedule(job)} · ${describeJobNextRun(job)}`;
    }
    const facts = cronJobNextRunFacts(job);
    // The detail header keeps the visible waiting reason.
    return facts.waiting && facts.enabled && !facts.running && !facts.autoDisabled
      ? describeJobNextRun(job)
      : readAutomationNextRun(facts);
  };
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
          <Show
            when={props.mode === "job" && props.canManage ? props.selectedJob : undefined}
            keyed
          >
            {(job) => <EnabledSwitch {...props} job={job} />}
          </Show>
          <span class="cron-detail-sub">
            <Show when={scheduleIcon()}>
              {(name) => (
                <span
                  class="cron-detail-sub__schedule"
                  role="img"
                  aria-label={cadence()}
                  title={cadence()}
                >
                  <Icon name={name()} />
                </span>
              )}
            </Show>
            {subtitle()}
          </span>
          {props.selectedJob?.trigger ? <TriggerIndicator /> : undefined}
        </div>
      </div>
      <div class="cron-detail-actions">
        <Show when={props.mode === "job" && props.canManage ? props.selectedJob : undefined} keyed>
          {(job) => (
            <>
              <button
                type="button"
                class="btn btn--sm"
                data-test-id="cron-run-now"
                disabled={props.busy || !props.connected}
                onClick={() => props.onRun(job, "force")}
              >
                <Icon name="play" /> {t("cron.actions.runNow")}
              </button>
              <JobMenu {...props} job={job} />
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
function DetailTabs(props: CronProps) {
  return (
    <HubTabs
      {...{
        id: "cron-detail",
        panelId: "cron-detail-panel",
        class: "cron-tabs",
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
