import { Show } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import type { IconName } from "../../components/solid/icon.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { isCronJobActiveFailure, isCronJobRunning } from "../../lib/cron-status.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatMs, formatRelativeTimestamp } from "../../lib/format.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
export function describeJobSchedule(job: CronJob): string {
  if (job.schedule.kind !== "event") {
    return formatCronSchedule(job);
  }
  const { source, options } = job.schedule;
  return source === "mcp-events"
    ? t("cron.events.summary", {
        server: typeof options.server === "string" ? options.server : "",
        name: typeof options.name === "string" ? options.name : "",
      })
    : `${t("cron.events.label")}: ${source}`;
}

/** The zone stays separate so the phone card can drop it; the detail view keeps it. */
export function JobSchedule(props: { job: CronJob }) {
  const schedule = () => props.job.schedule;
  const zone = () => {
    const current = schedule();
    return current.kind === "cron" ? current.tz : undefined;
  };
  const expression = () => {
    const current = schedule();
    return current.kind === "cron"
      ? formatCronSchedule({ schedule: { ...current, tz: undefined } })
      : describeJobSchedule(props.job);
  };
  return (
    <>
      {expression()}
      {zone() ? <span class="cron-table__schedule-zone"> ({zone()})</span> : undefined}
    </>
  );
}

/** Runtime facts, not the authored occurrence, decide what happens next. */
export function describeJobNextRun(job: CronJob, absolute = false): string {
  if (isCronJobRunning(job)) {
    return t("cron.runs.runStatusRunning");
  }
  if (job.state?.autoDisabled) {
    return t("cron.attention.noNextRun");
  }
  if (!job.enabled) {
    return t("cron.list.paused");
  }
  const waiting = job.state?.admissionDeferred;
  if (waiting) {
    return t("cron.jobState.waiting", {
      reason: formatUiExternalText(waiting.reason),
      since: formatMs(waiting.sinceMs),
    });
  }
  const next = job.state?.nextRunAtMs;
  return next === undefined
    ? t("cron.form.noNextRun")
    : absolute
      ? t("cron.form.nextRunAt", { at: formatMs(next) })
      : t("cron.jobState.nextRelative", { at: formatRelativeTimestamp(next) });
}

export function JobStateIndicator(props: { job: CronJob }) {
  const presentation = (): [string, IconName | null, string] => {
    const autoDisabled = props.job.state?.autoDisabled;
    const waiting = props.job.enabled && props.job.state?.admissionDeferred;
    if (!isCronJobRunning(props.job) && waiting) {
      return waiting.attempts >= 5
        ? [
            "warning",
            "alertTriangle",
            t("cron.jobState.waitingWarning", { count: String(waiting.attempts) }),
          ]
        : ["paused", "clock", describeJobNextRun(props.job)];
    }
    return isCronJobRunning(props.job)
      ? ["running", "loader", t("cron.runs.runStatusRunning")]
      : autoDisabled
        ? ["error", "lock", disabledNoteLabel(autoDisabled)]
        : isCronJobActiveFailure(props.job)
          ? ["error", "alertTriangle", t("cron.runs.runStatusError")]
          : !props.job.enabled
            ? ["paused", "pause", t("cron.list.paused")]
            : ["active", null, t("cron.detail.active")];
  };
  return (
    <span
      class={["cron-table__state", `cron-table__state--${presentation()[0]}`]}
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
      class={[
        "cron-table__paused-note",
        props.job.state?.autoDisabled ? "cron-table__auto-disabled" : "muted",
      ]}
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
