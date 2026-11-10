import type { CronRunLogEntry, CronDeliveryStatus, CronRunsStatusValue } from "../../api/types.ts";
import { t } from "../../lib/reactive/i18n.ts";

export const RUN_STATUS_LABELS = new Map<CronRunsStatusValue, string>([
  ["ok", "cron.runs.runStatusOk"],
  ["error", "cron.runs.runStatusError"],
  ["skipped", "cron.runs.runStatusSkipped"],
]);
export const RUN_DELIVERY_LABELS = new Map<CronDeliveryStatus, string>([
  ["delivered", "cron.runs.deliveryDelivered"],
  ["not-delivered", "cron.runs.deliveryNotDelivered"],
  ["unknown", "cron.runs.deliveryUnknown"],
  ["not-requested", "cron.runs.deliveryNotRequested"],
]);
export function runStatusLabel(
  value: string,
  completion?: CronRunLogEntry["completionStatus"],
): string {
  if (value === "ok" && (completion === "failed" || completion === "unknown")) {
    const completionLabel = t(
      completion === "failed" ? "cron.runs.runStatusError" : "cron.runs.runStatusUnknown",
    );
    return `${t("cron.runs.runStatusOk")} · ${completionLabel}`;
  }
  return t(
    Array.from(RUN_STATUS_LABELS).find(([status]) => status === value)?.[1] ??
      "cron.runs.runStatusUnknown",
  );
}
