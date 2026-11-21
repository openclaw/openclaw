import { isUnrecordedScheduledAccountRefusal } from "../agents/scheduled-unrecorded-account.js";
import type { CronFailureNotificationDetail, CronRunOutcome } from "./types.js";

/** Classifies deterministic setup refusals that no retry of the same job can change. */
export function resolveCronConfigurationRefusal(
  error: unknown,
): Required<Pick<CronRunOutcome, "errorClassification" | "failureNotificationDetail">> | undefined {
  return isUnrecordedScheduledAccountRefusal(error)
    ? {
        errorClassification: { kind: "permanent" },
        failureNotificationDetail: { kind: "inference-account-unrecorded" },
      }
    : undefined;
}

/** True when the failure's closed detail names a setup refusal that pauses the job at once. */
export function isCronConfigurationRefusal(detail?: CronFailureNotificationDetail): boolean {
  return detail?.kind === "inference-account-unrecorded";
}
