import { resolveExactDurationParts } from "../../../../../src/infra/format-time/format-duration-exact.ts";
import type { CronJob } from "../../../api/types.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatDateMs, formatTimeMs, formatUnit } from "../../../lib/format.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

const localDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

/** Compact local wording for a one-shot row; "Today" is evaluated when the row renders. */
function oneShotSchedule(atMs: number): string {
  const at = new Date(atMs);
  const now = new Date();
  const days = localDay(at) - localDay(now);
  const day =
    days === 0
      ? t("chat.sessionAutomation.today")
      : days === 1
        ? t("chat.sessionAutomation.tomorrow")
        : formatDateMs(atMs, {
            month: "short",
            day: "numeric",
            ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
          });
  return t("chat.sessionAutomation.onceAt", { day, time: formatTimeMs(atMs) });
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
