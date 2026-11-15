import { createMemo, Show } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import { InlineAlert, type InlineAlertTone } from "../../components/solid/inline-alert.tsx";
import { isCronJobRunning, resolveCronJobLastRunStatus } from "../../lib/cron-status.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readVisibleTime } from "../../lib/reactive/visible-clock.ts";

/**
 * Where a failing automation is in its recovery:
 * - `retrying`: a quick re-run after a transient failure is scheduled; nobody is told yet.
 * - `repairing`: its owner conversation is working on a fix.
 * - `verifying`: the fix attempt finished (or ran out of time); the next run checks it.
 * - `needs-you`: a run after the fix attempt still failed, so the user was told.
 * - `failing`: the last run failed and no fix attempt applies.
 * - `disabled`: the scheduler turned the automation off after repeated failures.
 * `undefined` means nothing needs attention.
 */
export type CronFailurePhase =
  | "retrying"
  | "repairing"
  | "verifying"
  | "needs-you"
  | "failing"
  | "disabled";

export function resolveCronFailurePhase(
  job: Pick<CronJob, "enabled" | "state">,
  nowMs: number,
): CronFailurePhase | undefined {
  const repair = job.state?.failureRepair;
  // A terminal one-shot is already disabled while its owner works on the fix.
  if (
    repair &&
    !repair.escalatedAtMs &&
    repair.settledAtMs === undefined &&
    nowMs < repair.deadlineAtMs
  ) {
    return "repairing";
  }
  if (job.state?.autoDisabled) {
    return "disabled";
  }
  if (!job.enabled) {
    return undefined;
  }
  if (repair) {
    return repair.escalatedAtMs ? "needs-you" : "verifying";
  }
  if (job.state?.failureRetryAtMs !== undefined) {
    return "retrying";
  }
  return resolveCronJobLastRunStatus(job) === "error" ? "failing" : undefined;
}

const PHASE_TONE: Record<CronFailurePhase, InlineAlertTone> = {
  retrying: "info",
  repairing: "info",
  verifying: "info",
  "needs-you": "danger",
  failing: "warning",
  disabled: "danger",
};

const CAUSE_PREVIEW_CHARS = 140;

/** The failure banner leads with what happens next; the raw error stays behind a disclosure. */
export function FailureBanner(props: {
  job: CronJob;
  onReviewRun?: () => void;
  onOpenConversation?: () => void;
  onRun?: () => void;
}) {
  const now = () => readVisibleTime(30_000);
  const phase = createMemo(() => resolveCronFailurePhase(props.job, now()));
  const nextRun = () => {
    const nextRunAtMs = props.job.state.nextRunAtMs;
    return typeof nextRunAtMs === "number"
      ? createMsFormatter(undefined, t("common.na"))(nextRunAtMs)
      : undefined;
  };
  const cause = () => {
    const error = formatUiExternalText(props.job.state.lastError, t("cron.attention.causeUnknown"));
    const diagnostic = formatUiExternalText(props.job.state.lastDiagnosticSummary);
    return diagnostic && diagnostic !== error ? `${error}\n${diagnostic}` : error;
  };
  // Only states that ask the user to act lead with a short cause.
  const causePreview = () => {
    const current = phase();
    if (current !== "needs-you" && current !== "disabled") {
      return undefined;
    }
    const firstLine = cause().split("\n", 1)[0] ?? "";
    return firstLine.length > CAUSE_PREVIEW_CHARS
      ? `${firstLine.slice(0, CAUSE_PREVIEW_CHARS - 1)}…`
      : firstLine;
  };
  const title = () => {
    switch (phase()) {
      case "retrying":
        return t("cron.attention.retryingTitle");
      case "repairing":
        return t("cron.attention.repairingTitle");
      case "verifying":
        return t("cron.attention.verifyingTitle");
      case "needs-you":
        return t("cron.attention.needsYouTitle");
      case "disabled":
        return (props.job.state.autoDisabled?.consecutiveErrors ?? 0) > 1
          ? t("cron.attention.disabledTitle")
          : t("cron.attention.disabledAfterOneFailureTitle");
      default:
        return t("cron.attention.failingTitle");
    }
  };
  const message = () => {
    const time = nextRun();
    switch (phase()) {
      case "retrying":
        return time ? t("cron.attention.retryingNext", { time }) : t("cron.attention.retryingNow");
      case "repairing":
        return t("cron.attention.repairingBody");
      case "verifying":
        return isCronJobRunning(props.job) || !time || (props.job.state.nextRunAtMs ?? 0) <= now()
          ? t("cron.attention.verifyingNow")
          : t("cron.attention.verifyingNext", { time });
      case "needs-you":
        return time
          ? t("cron.attention.needsYouBody", { time })
          : t("cron.attention.needsYouNoNextRun");
      case "disabled":
        return t("cron.attention.disabledBody");
      default:
        return time ? t("cron.attention.failingNext", { time }) : t("cron.attention.noNextRun");
    }
  };
  const canOpenConversation = () =>
    Boolean(props.onOpenConversation && props.job.owner?.sessionKey) &&
    (phase() === "repairing" || phase() === "needs-you");
  const canRun = () => phase() === "needs-you" && Boolean(props.onRun);
  return (
    <Show when={phase()}>
      {(current) => (
        <InlineAlert
          tone={PHASE_TONE[current()]}
          class="cron-failure-details"
          data-phase={current()}
          title={title()}
        >
          <div>{message()}</div>
          <Show when={causePreview()}>
            {(preview) => <div class="muted cron-failure-details__cause">{preview()}</div>}
          </Show>
          <Show when={canOpenConversation() || canRun() || props.onReviewRun}>
            <div class="cron-failure-details__actions">
              <Show when={canOpenConversation()}>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-test-id="cron-open-conversation"
                  onClick={() => props.onOpenConversation?.()}
                >
                  {t("cron.attention.openConversation")}
                </button>
              </Show>
              <Show when={canRun()}>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-test-id="cron-attention-run-now"
                  onClick={() => props.onRun?.()}
                >
                  {t("cron.actions.runNow")}
                </button>
              </Show>
              <Show when={props.onReviewRun}>
                <button
                  type="button"
                  class="settings-row__desc-action"
                  data-test-id="cron-review-failed-run"
                  onClick={() => props.onReviewRun?.()}
                >
                  {t("cron.attention.reviewRun")}
                </button>
              </Show>
            </div>
          </Show>
          <details class="cron-error-details">
            <summary>{t("cron.attention.errorDetails")}</summary>
            <pre class="cron-error-details__text">{cause()}</pre>
          </details>
        </InlineAlert>
      )}
    </Show>
  );
}
