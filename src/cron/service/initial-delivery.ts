import { isDetachedDeliveryTarget } from "../normalize.js";
/** Resolves create-time default delivery for new cron jobs. */
import type { CronDelivery, CronJobCreate } from "../types.js";

/**
 * Resolves default cron delivery for new jobs when callers omit explicit delivery config.
 * This is the direct-service contract: supported creation paths (gateway `cron.add`,
 * agent cron tool) already fill delivery in `normalizeCronJobCreate`, so this default
 * only governs callers that reach `CronService.add`/declarative convergence directly.
 * The isDetachedDeliveryTarget predicate is shared with normalize.ts and delivery-plan.ts
 * so the contract stays consistent across write-time, read-time, and service-bypass paths.
 */
export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  const sessionTarget = typeof input.sessionTarget === "string" ? input.sessionTarget : "";
  const payloadKind = typeof input.payload.kind === "string" ? input.payload.kind : "";
  if (isDetachedDeliveryTarget(sessionTarget, payloadKind)) {
    return { mode: "announce" };
  }
  return undefined;
}
