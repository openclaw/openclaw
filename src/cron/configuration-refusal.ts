import {
  findErrorProperty,
  isFailoverError,
  readDirectErrorCode,
} from "../agents/failover/error.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CronRunOutcome } from "./types.js";

/** Code on the refusal for an automation whose recorded account was removed, signed out or replaced. */
export const CRON_INFERENCE_ACCOUNT_RETIRED_CODE = "CRON_INFERENCE_ACCOUNT_RETIRED";

// Refusals whose run also gave a candidate on another provider its own credentials. Kept across
// bundled chunks by identity, like other refusal facts.
const bypassedAccountRefusals = resolveGlobalSingleton(
  Symbol.for("openclaw.cronBypassedAccountRefusals"),
  () => new WeakSet<object>(),
);

/** The run reached a fallback on another provider, so the recorded account was not its only path. */
export function markCronAccountRefusalBypassed(refusal: unknown): void {
  if (refusal instanceof Error) {
    bypassedAccountRefusals.add(refusal);
  }
}

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
  return (
    refusal !== undefined && !(refusal instanceof Error && bypassedAccountRefusals.has(refusal))
  );
}

/** Classifies deterministic setup refusals that no retry of the same job can change. */
export function resolveCronConfigurationRefusal(
  error: unknown,
): Required<Pick<CronRunOutcome, "errorClassification" | "failureNotificationDetail">> | undefined {
  return isRetiredAccountRefusal(error)
    ? {
        errorClassification: { kind: "permanent" },
        failureNotificationDetail: { kind: "inference-account-retired" },
      }
    : undefined;
}
