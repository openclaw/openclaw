import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import type { CronFailureNotificationDetail, CronRunErrorClassification } from "./types.js";

/** Fixed copy shared by run history and the safe chat notification projection. */
export function formatCronWatchdogFailure(
  reason: Extract<CronFailureNotificationDetail, { kind: "agent-watchdog" }>["reason"],
): string {
  return reason === "execution_deadline"
    ? "Session watchdog stopped the run after its execution deadline."
    : "Session watchdog stopped the run after no semantic progress.";
}

export type CronWatchdogFailure = {
  error: string;
  errorClassification: Extract<CronRunErrorClassification, { kind: "permanent" }>;
  failureNotificationDetail: Extract<CronFailureNotificationDetail, { kind: "agent-watchdog" }>;
};

/** Read the captured controller's signal, never provider prose or a replacement cleanup error. */
export function resolveCronWatchdogFailure(
  signal: AbortSignal | undefined,
): CronWatchdogFailure | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  try {
    const error = signal.reason;
    if (!(error instanceof Error) || extractErrorCode(error) !== "OPENCLAW_SESSION_WATCHDOG") {
      return undefined;
    }
    const reason = error.cause;
    if (reason !== "execution_deadline" && reason !== "semantic_stall") {
      return undefined;
    }
    return {
      error: formatCronWatchdogFailure(reason),
      // A stalled, already-started tool is not a transient model-provider failure.
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: { kind: "agent-watchdog", reason },
    };
  } catch {
    // An opaque cancellation reason cannot authorize classified chat disclosure.
    return undefined;
  }
}
