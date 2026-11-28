import { findErrorProperty, isFailoverError } from "../agents/failover/error.js";
import { isUnrecordedScheduledAccountRefusal } from "../agents/scheduled-unrecorded-account.js";
import { CRON_INFERENCE_ACCOUNT_RETIRED_CODE } from "./inference-binding.js";
import type { CronRunOutcome } from "./types.js";

/** True when the run reached its recorded account and that account was removed or signed out. */
function isRetiredAccountRefusal(error: unknown): boolean {
  return (
    findErrorProperty(error, (candidate) =>
      (candidate as { code?: unknown } | null)?.code === CRON_INFERENCE_ACCOUNT_RETIRED_CODE ||
      (isFailoverError(candidate) &&
        candidate.attempts?.some((attempt) => attempt.code === CRON_INFERENCE_ACCOUNT_RETIRED_CODE))
        ? true
        : undefined,
    ) === true
  );
}

/** Classifies deterministic setup refusals that no retry of the same job can change. */
export function resolveCronConfigurationRefusal(
  error: unknown,
): Required<Pick<CronRunOutcome, "errorClassification" | "failureNotificationDetail">> | undefined {
  if (isUnrecordedScheduledAccountRefusal(error)) {
    return {
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: { kind: "inference-account-unrecorded" },
    };
  }
  return isRetiredAccountRefusal(error)
    ? {
        errorClassification: { kind: "permanent" },
        failureNotificationDetail: { kind: "inference-account-retired" },
      }
    : undefined;
}
