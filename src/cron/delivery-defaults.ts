/** Shared create- and run-time defaults for cron result delivery. */
import { assertCanonicalCronDeliveryMode } from "./store/delivery-codec.js";
import type { CronDelivery, CronJob } from "./types.js";

/**
 * Keep create-time normalization, direct service persistence, and run-time
 * planning on one target policy; disagreement silently drops cron results.
 */
export function shouldDefaultCronDeliveryToAnnounce(params: {
  payloadKind: unknown;
  sessionTarget: unknown;
}): boolean {
  if (
    params.payloadKind !== "agentTurn" &&
    params.payloadKind !== "command" &&
    params.payloadKind !== "script"
  ) {
    return false;
  }
  return (
    params.sessionTarget === "isolated" ||
    params.sessionTarget === "current" ||
    (typeof params.sessionTarget === "string" && params.sessionTarget.startsWith("session:"))
  );
}

/** Resolves the configured mode without loading runtime destination routing. */
export function resolveCronDeliveryMode(
  job: Pick<CronJob, "delivery"> & Partial<Pick<CronJob, "payload" | "sessionTarget">>,
): CronDelivery["mode"] {
  assertCanonicalCronDeliveryMode(job.delivery);
  if (job.delivery) {
    return job.delivery.mode;
  }
  return job.payload &&
    job.sessionTarget &&
    shouldDefaultCronDeliveryToAnnounce({
      payloadKind: job.payload.kind,
      sessionTarget: job.sessionTarget,
    })
    ? "announce"
    : "none";
}
