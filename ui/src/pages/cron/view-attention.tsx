import type { CronJob } from "../../api/types.ts";
import { isCronJobRunning } from "../../lib/cron-status.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { CronProps } from "./view-types.ts";

export function FailureDetails(props: { job: CronJob; onSelectJob: CronProps["onSelectJob"] }) {
  const formatTimestamp = () => createMsFormatter(undefined, t("common.na"));
  const cause = () =>
    formatUiExternalText(props.job.state.lastError, t("cron.attention.causeUnknown"));
  const diagnostic = () => formatUiExternalText(props.job.state.lastDiagnosticSummary);
  const consequence = () => {
    if (props.job.state.autoDisabled) {
      return t("cron.attention.autoDisabledConsequence");
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
    <section
      class="cron-failure-details"
      data-test-id="cron-failure-details"
      aria-label={t("cron.attention.title")}
    >
      <h2>
        {t(
          props.job.state.autoDisabled
            ? "cron.attention.autoDisabledTitle"
            : "cron.attention.title",
        )}
      </h2>
      <p class="cron-failure-details__cause">{cause()}</p>
      {diagnostic() && diagnostic() !== cause() ? (
        <p class="cron-failure-details__cause">{diagnostic()}</p>
      ) : undefined}
      <p>{consequence()}</p>
      <p>{t("cron.attention.effectsUnknown")}</p>
      <button
        type="button"
        class="btn btn--secondary btn--sm"
        data-test-id="cron-review-failed-run"
        onClick={() => props.onSelectJob(props.job)}
      >
        {t("cron.attention.reviewRun")}
      </button>
    </section>
  );
}
