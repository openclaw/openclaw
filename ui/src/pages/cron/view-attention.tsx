import type { CronJob } from "../../api/types.ts";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
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
    <SettingsDisclosure
      class="cron-failure-details"
      title={
        <SettingsStatus
          kind="danger"
          label={t(
            props.job.state.autoDisabled
              ? "cron.attention.autoDisabledTitle"
              : "cron.attention.title",
          )}
        />
      }
      description={cause()}
      actions={
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          data-test-id="cron-review-failed-run"
          onClick={(event) => {
            // Reviewing the run is independent of opening the diagnostic disclosure.
            event.preventDefault();
            props.onSelectJob(props.job);
          }}
        >
          {t("cron.attention.reviewRun")}
        </button>
      }
    >
      <div class="settings-row cron-failure-details__body">
        <div class="stack">
          <span class="settings-row__desc cron-failure-details__cause">{cause()}</span>
          {diagnostic() && diagnostic() !== cause() ? (
            <span class="settings-row__desc">{diagnostic()}</span>
          ) : undefined}
          <span class="settings-row__desc">{consequence()}</span>
          <span class="settings-row__desc">{t("cron.attention.effectsUnknown")}</span>
        </div>
      </div>
    </SettingsDisclosure>
  );
}
