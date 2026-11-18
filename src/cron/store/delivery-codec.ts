/** JSON codec for cron delivery configuration and explicit destination clears. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE =
  'cron delivery requires an explicit mode: "none", "announce", or "webhook"; run openclaw doctor --fix for legacy settings or explicitly edit delivery.mode';

export function hasCanonicalCronDeliveryMode(delivery: unknown): boolean {
  return (
    delivery === undefined ||
    (isRecord(delivery) &&
      (delivery.mode === "none" || delivery.mode === "announce" || delivery.mode === "webhook"))
  );
}

/** Unrepaired definitions remain readable; execution and authored writes require a mode. */
export function assertCanonicalCronDeliveryMode(delivery: unknown): void {
  if (!hasCanonicalCronDeliveryMode(delivery)) {
    throw new Error(CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE);
  }
}

export const CRON_FAILURE_SETTINGS_REPAIR_REQUIRED_MESSAGE =
  "automation has retired failure alert or delivery settings; run openclaw doctor --fix before running or editing it";

export function hasCanonicalCronFailureSettings(job: {
  delivery?: unknown;
  failureAlert?: unknown;
}): boolean {
  return (
    (job.failureAlert === undefined || typeof job.failureAlert === "boolean") &&
    (!isRecord(job.delivery) ||
      (!Object.hasOwn(job.delivery, "failureDestination") &&
        !Object.hasOwn(job.delivery, "bestEffort")))
  );
}
