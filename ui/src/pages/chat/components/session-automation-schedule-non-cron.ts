import { resolveExactDurationParts } from "../../../../../src/infra/format-time/format-duration-exact.ts";
import type { CronJob } from "../../../api/types.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { formatUnit } from "../../../lib/format.ts";
import { formatCronSchedule } from "../../../lib/presenter.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function nonCronSessionAutomationSchedule(
  schedule: Exclude<CronJob["schedule"], { kind: "cron" }>,
): string {
  return schedule.kind === "every"
    ? t("chat.sessionAutomation.everyDuration", {
        duration:
          resolveExactDurationParts(schedule.everyMs)
            ?.map((part) => formatUnit({ ...part, unitDisplay: "long" }))
            .join(" ") ?? t("common.na"),
      })
    : formatCronSchedule({ schedule });
}
