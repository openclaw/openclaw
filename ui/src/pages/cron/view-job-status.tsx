import { createMemo, Show } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import type { IconName } from "../../components/solid/icon.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  isCronJobActiveFailure,
  isCronJobRunning,
  resolveCronJobLastRunStatus,
} from "../../lib/cron-status.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { runStatusLabel } from "./view-runs.tsx";
export function JobStateIndicator(props: { job: CronJob }) {
  const presentation = createMemo((): [string, IconName | null, string] => {
    const autoDisabled = props.job.state?.autoDisabled;
    return isCronJobRunning(props.job)
      ? ["running", "loader", t("cron.runs.runStatusRunning")]
      : autoDisabled
        ? ["error", "lock", disabledNoteLabel(autoDisabled)]
        : isCronJobActiveFailure(props.job)
          ? ["error", "alertTriangle", t("cron.runs.runStatusError")]
          : !props.job.enabled
            ? ["paused", "pause", t("cron.list.paused")]
            : ["active", null, t("cron.detail.active")];
  });
  return (
    <span
      class={`cron-table__state cron-table__state--${presentation()[0]}`}
      role="img"
      aria-label={presentation()[2]}
      title={presentation()[2]}
    >
      <Show when={presentation()[1]} fallback={<span class="cron-table__state-dot" />}>
        {(name) => <Icon name={name()} />}
      </Show>
    </span>
  );
}
export function TriggerIndicator() {
  return (
    <span
      class="cron-trigger-icon"
      role="img"
      aria-label={t("cron.form.triggerConfigured")}
      title={t("cron.form.triggerConfigured")}
    >
      <Icon name="gitBranch" />
    </span>
  );
}
/** Auto-disabled is an escalated failure, not an operator pause. */
export function DisabledNote(props: { job: CronJob }) {
  const label = () => {
    const autoDisabled = props.job.state?.autoDisabled;
    return autoDisabled ? disabledNoteLabel(autoDisabled) : t("cron.list.paused");
  };
  return (
    <span
      class={
        props.job.state?.autoDisabled
          ? "cron-table__paused-note cron-table__auto-disabled"
          : "muted cron-table__paused-note"
      }
      data-test-id={
        props.job.state?.autoDisabled ? `cron-row-auto-disabled-${props.job.id}` : undefined
      }
      title={
        props.job.state?.autoDisabled
          ? formatUiExternalText(props.job.state.lastError?.trim()) || label()
          : undefined
      }
    >
      {label()}
    </span>
  );
}
function disabledNoteLabel(data: NonNullable<NonNullable<CronJob["state"]>["autoDisabled"]>) {
  return t(
    data.reason === "schedule-errors"
      ? "cron.list.autoDisabledScheduleErrors"
      : "cron.list.autoDisabledRunFailures",
    { count: String(data.consecutiveErrors) },
  );
}
export function LastRunCell(props: { job: CronJob }) {
  const status = () => resolveCronJobLastRunStatus(props.job);
  const relative = () => {
    const time = props.job.state?.lastRunAtMs;
    return typeof time === "number" && Number.isFinite(time) ? formatRelativeTimestamp(time) : null;
  };
  return (
    <>
      {status() === "unknown" || !relative() ? (
        <span class="muted">{t("common.na")}</span>
      ) : (
        <span
          class="cron-table__last-run"
          role="img"
          aria-label={runStatusLabel(status())}
          title={runStatusLabel(status())}
        >
          <span
            class={[
              "cron-last-glyph",
              {
                "cron-last-glyph--ok": status() === "ok",
                "cron-last-glyph--error": status() === "error",
              },
            ]}
          >
            <Icon
              name={status() === "ok" ? "check" : status() === "error" ? "x" : "cornerDownRight"}
            />
          </span>
          <span class="cron-table__last-time">{relative()}</span>
        </span>
      )}
    </>
  );
}
