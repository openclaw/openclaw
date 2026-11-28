import {
  findErrorProperty,
  isFailoverError,
  readDirectErrorCode,
} from "../agents/failover/error.js";
import { isUnrecordedScheduledAccountRefusal } from "../agents/scheduled-unrecorded-account.js";
import {
  CRON_INFERENCE_ACCOUNT_RETIRED_CODE,
  isCronAccountRefusalBypassed,
} from "./inference-binding.js";
import type { CronRunOutcome } from "./types.js";

/**
 * True when the run's only way to execute was its recorded account, and that account is gone or
 * replaced. A fallback summary keeps each attempt's code but only the last attempt's error, so
 * it decides by its attempts; a surfaced refusal decides by whether a fallback on another
 * provider also ran, since that fallback may still recover.
 */
function isRetiredAccountRefusal(error: unknown): boolean {
  const attempts = findErrorProperty(error, (candidate) =>
    isFailoverError(candidate) && candidate.attempts?.length ? candidate.attempts : undefined,
  );
  if (attempts) {
    return attempts.every((attempt) => attempt.code === CRON_INFERENCE_ACCOUNT_RETIRED_CODE);
  }
  const refusal = findErrorProperty(error, (candidate) =>
    readDirectErrorCode(candidate) === CRON_INFERENCE_ACCOUNT_RETIRED_CODE ? candidate : undefined,
  );
  return refusal !== undefined && !isCronAccountRefusalBypassed(refusal);
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
