import type { CronCompactJob } from "../../../api/types.ts";
import { isRecurringSchedule, readAutomationNextRun } from "../../../lib/presenter.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { DetailsAutomation } from "../chat-details-snapshot.ts";

/** One row model for desktop and mobile Session Details; cadence is added only where shown. */
export function sessionAutomationRow(job: CronCompactJob, connected: boolean): DetailsAutomation {
  const active = job.enabled && !job.autoDisabled;
  return {
    id: job.id,
    name: job.name,
    disabled: !job.enabled || undefined,
    autoDisabled: job.autoDisabled ? true : undefined,
    running: job.runningAtMs === undefined ? undefined : (connected && active) || undefined,
    waiting: (active && job.admissionDeferred !== undefined) || undefined,
    timing: job.schedule ? (isRecurringSchedule(job.schedule) ? "recurring" : "once") : undefined,
    state: job.autoDisabled
      ? t("chat.sessionDetails.automationAttention")
      : !job.enabled
        ? t("chat.sessionDetails.automationPaused")
        : connected && job.runningAtMs !== undefined
          ? t("common.running")
          : "",
    nextRunAtMs: active ? job.nextRunAtMs : null,
  };
}

/** Timed rows show the scheduler-owned next run; watchers and older cached rows keep their state. */
export function sessionAutomationTiming(row: DetailsAutomation): string {
  return row.timing && !row.autoDisabled
    ? readAutomationNextRun({
        enabled: !row.disabled,
        running: Boolean(row.running),
        autoDisabled: false,
        waiting: Boolean(row.waiting),
        nextRunAtMs: row.nextRunAtMs ?? null,
      })
    : row.state;
}
