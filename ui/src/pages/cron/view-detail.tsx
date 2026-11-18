import { createMemo, Show } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import { highlightCodeHtml } from "../../components/markdown-code-blocks.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { isCronJobActiveFailure } from "../../lib/cron-status.ts";
import { jobToForm } from "../../lib/cron/form.ts";
import { formatCronCadence } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { failedRunId } from "./route-model.ts";
import { FailureDetails } from "./view-attention.tsx";
import {
  AdminRequired,
  BackRow,
  ErrorBanner,
  EnabledSwitch,
  JobMenu,
  NoticeBanner,
} from "./view-controls.tsx";
import { Editor, EditorActions } from "./view-editor.tsx";
import { describeJobNextRun, describeJobSchedule, TriggerIndicator } from "./view-job-status.tsx";
import { RunHistory } from "./view-runs.tsx";
import { CronSuggestionLists } from "./view-suggestions.tsx";
import type { CronProps, CronPanelMode } from "./view-types.ts";
export function DetailView(
  props: CronProps & {
    mode: CronPanelMode;
  },
) {
  // Keep control placement on the same breakpoint as cron.css.
  const phoneLayout = createMediaQuery("(max-width: 640px)");
  // Status refresh updates the selected job's runtime facts in place.
  const selectedJob = createMemo(
    () => (props.mode === "job" ? (props.editingJob ?? undefined) : undefined),
    { equals: false },
  );
  // A saved automation opens on its prompt and history; Edit (the settings tab) swaps in the form.
  const editing = () => props.mode !== "job" || props.detailTab !== "history";
  const failedJob = () => {
    const job = selectedJob();
    return job && isCronJobActiveFailure(job) ? job : undefined;
  };
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
    <section
      class={["cron-page cron-page--detail", { "cron-page--create": props.mode === "create" }]}
      data-panel-mode={props.mode}
      data-view={editing() ? "edit" : "detail"}
    >
      <SettingsPage>
        <BackRow {...props} />
        <DetailHeader
          {...props}
          mode={props.mode}
          editing={editing()}
          phoneLayout={phoneLayout()}
          selectedJob={selectedJob()}
        />
        <AdminRequired {...props} />
        <ErrorBanner error={props.error} reads={editing() ? props.reads : undefined} />
        <NoticeBanner notice={props.notice} />
        <div id="cron-detail-panel" class="cron-tab-panel">
          {editing() ? (
            <>
              <Editor {...props} mode={props.mode} phoneLayout={phoneLayout()} />
              <CronSuggestionLists {...props} />
            </>
          ) : (
            <Show when={selectedJob()} keyed>
              {(job) => (
                <>
                  <SavedPrompt {...props} job={job} />
                  <Show when={failedJob()}>
                    {(failed) => (
                      <FailureDetails
                        job={failed()}
                        onReviewRun={(() => {
                          // Review opens the failed run in the history below; without one there is none.
                          const runId = failedRunId(failed());
                          return runId ? () => props.onSelectJob(failed(), runId) : undefined;
                        })()}
                      />
                    )}
                  </Show>
                  <RunHistory
                    {...props}
                    title={t("cron.detail.historyTitle")}
                    conditionActivity={conditionActivity()}
                  />
                </>
              )}
            </Show>
          )}
        </div>
      </SettingsPage>
    </section>
  );
}
function DetailHeader(
  props: CronProps & {
    mode: CronPanelMode;
    editing: boolean;
    phoneLayout: boolean;
    selectedJob?: CronJob;
  },
) {
  const title = () =>
    props.mode === "job"
      ? (props.selectedJob?.displayName ?? props.selectedJob?.name ?? props.form.name)
      : t("cron.detail.newTitle");
  const reading = () => props.mode === "job" && !props.editing;
  const description = () => (reading() ? props.selectedJob?.description?.trim() : undefined);
  // Header describes the SAVED job (schedule + next run); the form's live
  // summary describes unsaved edits, so the two never contradict each other.
  // The cadence reads as the Automations sidebar does ("Daily"); event triggers keep their source.
  const subtitle = () => {
    const job = props.selectedJob;
    return reading() && job
      ? `${
          job.schedule.kind === "event" ? describeJobSchedule(job) : formatCronCadence(job)
        } · ${describeJobNextRun(job)}`
      : undefined;
  };
  return (
    <div class="cron-detail-header">
      <div class="cron-detail-header__copy">
        <h1 class="cron-detail-title">{title()}</h1>
        {subtitle() ? (
          <div class="cron-detail-meta">
            <span class="cron-detail-sub">{subtitle()}</span>
            {props.selectedJob?.trigger ? <TriggerIndicator /> : undefined}
          </div>
        ) : undefined}
        {description() ? (
          <div class="cron-detail-description" data-test-id="cron-detail-description">
            {description()}
          </div>
        ) : undefined}
      </div>
      <Show
        when={
          props.mode === "job" && !(props.editing && props.phoneLayout)
            ? props.selectedJob
            : undefined
        }
        keyed
      >
        {(job) => (
          <div class="cron-detail-actions">
            {props.canManage ? <EnabledSwitch {...props} job={job} /> : undefined}
            {props.editing ? (
              <EditorActions {...props} mode="job" onCancel={() => props.onCancelEdit()} />
            ) : props.canManage ? (
              <>
                <button
                  type="button"
                  class="btn btn--sm cron-run-now"
                  data-test-id="cron-run-now"
                  disabled={props.busy || !props.connected}
                  onClick={() => props.onRun(job)}
                >
                  <Icon name="play" /> {t("cron.actions.runNow")}
                </button>
                <JobMenu {...props} job={job} />
              </>
            ) : undefined}
          </div>
        )}
      </Show>
    </div>
  );
}
/** The saved prompt, read-only, on the composer's sheet; the tray says when and how it runs. */
function SavedPrompt(props: CronProps & { job: CronJob }) {
  const saved = createMemo(() => jobToForm(props.job, props.form));
  const delivery = () => {
    const mode = saved().deliveryMode;
    return mode === "announce"
      ? t("cron.form.announceDefault")
      : mode === "webhook"
        ? t("cron.form.webhookPost")
        : mode === "none"
          ? t("cron.form.noneInternal")
          : undefined;
  };
  const facts = () =>
    [
      describeJobSchedule(props.job),
      saved().payloadKind === "agentTurn"
        ? saved().payloadModel || t("quickSettings.model.default")
        : undefined,
      delivery(),
    ].filter(Boolean);
  return (
    <div class="cron-prompt" data-test-id="cron-saved-prompt">
      <div class="cron-prompt__sheet">
        {saved().payloadLocked ? (
          <pre class="code-block cron-payload-code cron-payload-code--saved" tabindex="0">
            <SanitizedHtml
              tag="code"
              class="hljs"
              html={highlightCodeHtml(
                saved().payloadText,
                saved().payloadKind === "script" ? "javascript" : "bash",
              )}
            />
          </pre>
        ) : (
          <div
            class="cron-prompt__saved-text"
            tabindex="0"
            role="region"
            aria-label={t("cron.form.promptPreview")}
          >
            {saved().payloadText}
          </div>
        )}
      </div>
      <div class="cron-prompt__tray">
        <div class="cron-prompt__controls">
          <span class="cron-prompt__clock" aria-hidden="true">
            <Icon name="clock" />
          </span>
          <span class="cron-prompt__facts">{facts().join(" · ")}</span>
          <button
            type="button"
            class="btn btn--sm cron-prompt__edit"
            data-test-id="cron-edit"
            onClick={() => props.onDetailTabChange("settings")}
          >
            <Icon name={props.canManage ? "pencil" : "settings"} />{" "}
            {t(props.canManage ? "cron.detail.edit" : "cron.detail.settingsTab")}
          </button>
        </div>
      </div>
    </div>
  );
}
