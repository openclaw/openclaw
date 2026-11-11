import { resolveExactDurationParts } from "../../../../../src/infra/format-time/format-duration-exact.ts";
import type { CronJob } from "../../../api/types.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerCronScheduleEnglish } from "../../../i18n/locales/en-cron-schedule.ts";
import { formatDateMs, formatTimeMs, formatUnit } from "../../../lib/format.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);
// Next-run wording lives in the lazy schedule catalog, outside the Chat boot chunks.
registerEnglishCatalog(registerCronScheduleEnglish);

const localDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

/** Local calendar distance and short date, evaluated when the row renders. */
function scheduledDay(atMs: number): { days: number; date: string } {
  const at = new Date(atMs);
  const now = new Date();
  return {
    days: localDay(at) - localDay(now),
    date: formatDateMs(atMs, {
      month: "short",
      day: "numeric",
      ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    }),
  };
}

/** Compact local wording for a one-shot row; today is just the time. */
function oneShotSchedule(atMs: number): string {
  const { days, date } = scheduledDay(atMs);
  if (days === 0) {
    return formatTimeMs(atMs);
  }
  const day = days === 1 ? t("chat.sessionAutomation.tomorrow") : date;
  return t("chat.sessionAutomation.onceAt", { day, time: formatTimeMs(atMs) });
}

/** Tooltip wording for the scheduler-owned next run; null means nothing is queued. */
export function sessionAutomationNextRun(atMs: number | null): string {
  if (atMs === null) {
    return t("cron.scheduleLabel.noNextRun");
  }
  const { days, date } = scheduledDay(atMs);
  const time = formatTimeMs(atMs);
  return days === 0
    ? t("cron.scheduleLabel.nextRunToday", { time })
    : days === 1
      ? t("cron.scheduleLabel.nextRunTomorrow", { time })
      : t("cron.scheduleLabel.nextRunOn", { day: date, time });
}

export function nonCronSessionAutomationSchedule(
  schedule: Exclude<CronJob["schedule"], { kind: "cron" }>,
): string {
  if (schedule.kind === "at") {
    const atMs = Date.parse(schedule.at);
    if (Number.isFinite(atMs)) {
      return oneShotSchedule(atMs);
    }
  }
  return schedule.kind === "every"
    ? t("chat.sessionAutomation.everyDuration", {
        duration:
          resolveExactDurationParts(schedule.everyMs)
            ?.map((part) => formatUnit({ ...part, unitDisplay: "long" }))
            .join(" ") ?? t("common.na"),
      })
    : formatCronSchedule({ schedule });
}
