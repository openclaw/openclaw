import type { CronJob } from "../../api/types.ts";
import { isCronJobRunning } from "../../lib/cron-status.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";

/** Saved-job diagnostics remain available even when the run is no longer retained. */
export function FailureDetails(props: {
  job: CronJob;
  fullCause?: boolean;
  onReviewRun?: () => void;
}) {
  const formatTimestamp = () => createMsFormatter(undefined, t("common.na"));
  const cause = () => {
    const error = formatUiExternalText(props.job.state.lastError, t("cron.attention.causeUnknown"));
    const diagnostic = formatUiExternalText(props.job.state.lastDiagnosticSummary);
    return diagnostic && diagnostic !== error ? `${error} — ${diagnostic}` : error;
  };
  // A stopped job shows that state in its header; caution about repeated effects matters more here.
  const outcome = () => {
    if (props.job.state.autoDisabled) {
      return t("cron.attention.effectsUnknown");
    }
    if (isCronJobRunning(props.job)) {
      return t("cron.attention.running");
    }
    const nextRunAtMs = props.job.state.nextRunAtMs;
    return typeof nextRunAtMs === "number"
      ? t("cron.attention.nextRun", { time: formatTimestamp()(nextRunAtMs) })
      : t("cron.attention.noNextRun");
  };
  return (
    <div class="callout danger cron-failure-details">
      <div>
        <strong>
          {t(
            props.job.state.autoDisabled
              ? "cron.attention.autoDisabledTitle"
              : "cron.attention.title",
          )}
        </strong>
        {" · "}
        {outcome()}
        {props.onReviewRun ? (
          <>
            {" "}
            <button
              type="button"
              class="settings-row__desc-action"
              data-test-id="cron-review-failed-run"
              onClick={() => props.onReviewRun?.()}
            >
              {t("cron.attention.reviewRun")}
            </button>
          </>
        ) : undefined}
      </div>
      <div
        class={[
          "muted cron-failure-details__cause",
          { "cron-failure-details__cause--preview": !props.fullCause },
        ]}
        title={cause()}
      >
        {cause()}
      </div>
    </div>
  );
}
