import type { CronRunResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

export function cronRunNotStartedMessage(result: CronRunResult): string {
  if (!("reason" in result)) {
    return t("cron.runNotStarted.unknown");
  }
  switch (result.reason) {
    case "not-due":
      return t("cron.runNotStarted.notDue");
    case "already-running":
      return t("cron.runNotStarted.alreadyRunning");
    case "invalid-spec":
      return t("cron.runNotStarted.invalidSpec");
    case "stopped":
      return t("cron.runNotStarted.stopped");
    case "disabled":
    case "ownerless":
      break;
  }
  return t("cron.runNotStarted.unknown");
}
