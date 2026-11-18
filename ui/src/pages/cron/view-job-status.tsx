import type { CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { isCronJobRunning } from "../../lib/cron-status.ts";
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
