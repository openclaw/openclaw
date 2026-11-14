import type { CronRunResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerCronEnglish } from "../../i18n/locales/en-cron.ts";

registerCronEnglish();

const NOT_STARTED_MESSAGES = new Map([
  ["not-due", "cron.runNotStarted.notDue"],
  ["already-running", "cron.runNotStarted.alreadyRunning"],
  ["invalid-spec", "cron.runNotStarted.invalidSpec"],
  ["stopped", "cron.runNotStarted.stopped"],
]);

// The job is fine and the request was answered; every other reason needs the operator.
const NOTICE_REASONS = new Set(["not-due", "already-running"]);

export function isCronRunNotStartedNotice(result: CronRunResult): boolean {
  return "reason" in result && NOTICE_REASONS.has(result.reason);
}

export function cronRunNotStartedMessage(result: CronRunResult): string {
  return t(
    ("reason" in result && NOT_STARTED_MESSAGES.get(result.reason)) || "cron.runNotStarted.unknown",
  );
}
