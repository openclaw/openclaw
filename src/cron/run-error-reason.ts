import { resolveFailoverReasonFromError } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { CronRunErrorClassification } from "./types.js";

/** Resolve one cron-owned classification before falling back to provider error inference. */
export function resolveCronRunErrorReason(
  error: unknown,
  provider?: string,
  classification?: CronRunErrorClassification,
): FailoverReason | undefined {
  if (classification?.kind === "permanent") {
    return undefined;
  }
  if (classification?.kind === "reason") {
    return classification.reason;
  }
  // Text-only failures without a model provider have no provider provenance.
  // In particular, heartbeat delivery errors can contain generic HTTP 5xx
  // wording that the model failover classifier would otherwise call a timeout.
  if (!provider?.trim()) {
    return undefined;
  }
  return resolveFailoverReasonFromError(error, provider) ?? undefined;
}
