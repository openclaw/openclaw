import type { SessionAutomationPauseResult } from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";

/** Batch sessions can share a job, so receipts classify outcomes without adding duplicate counts. */
export function archiveAutomationPauseNotice(
  results: readonly (SessionAutomationPauseResult | undefined)[],
): { message: string; warning: boolean } | null {
  if (results.some((result) => result?.status === "partial" || result?.status === "failed")) {
    return { message: t("sessionsView.automationPauseIncomplete"), warning: true };
  }
  if (results.some((result) => result?.status === "skipped")) {
    return { message: t("sessionsView.automationPauseSkipped"), warning: true };
  }
  if (results.some((result) => result?.status === "complete" && result.pausedCount > 0)) {
    return { message: t("sessionsView.automationPauseComplete"), warning: false };
  }
  return null;
}
