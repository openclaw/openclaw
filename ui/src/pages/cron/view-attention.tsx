import { createSignal, createUniqueId, Show, untrack } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
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
  const causeId = createUniqueId();
  // Raw errors are diagnostics: collapsed unless the reader asks for them.
  const [open, setOpen] = createSignal(untrack(() => props.fullCause === true));
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
    <div class="cron-failure-details" role="alert">
      <div class="cron-failure-details__line">
        <span class="cron-failure-details__dot" aria-hidden="true" />
        <span class="cron-failure-details__copy">
          <strong>
            {t(
              props.job.state.autoDisabled
                ? "cron.attention.autoDisabledTitle"
                : "cron.attention.title",
            )}
          </strong>
          <span class="cron-failure-details__outcome">
            {" · "}
            {outcome()}
          </span>
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
        </span>
        <button
          type="button"
          class="cron-failure-details__toggle"
          data-test-id="cron-failure-details-toggle"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={causeId}
          onClick={() => setOpen((value) => !value)}
        >
          {t("cron.attention.errorDetails")}
          <Icon name="chevronDown" />
        </button>
      </div>
      <Show when={open()}>
        <pre id={causeId} class="cron-error-details__text">
          {cause()}
        </pre>
      </Show>
    </div>
  );
}
