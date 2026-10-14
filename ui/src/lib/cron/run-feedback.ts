import type { CronRunResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

const NOT_STARTED_MESSAGES = new Map([
  ["not-due", "cron.runNotStarted.notDue"],
  ["already-running", "cron.runNotStarted.alreadyRunning"],
  ["invalid-spec", "cron.runNotStarted.invalidSpec"],
  ["stopped", "cron.runNotStarted.stopped"],
]);

export function cronRunNotStartedMessage(result: CronRunResult): string {
  return t(
    ("reason" in result && NOT_STARTED_MESSAGES.get(result.reason)) || "cron.runNotStarted.unknown",
  );
}
