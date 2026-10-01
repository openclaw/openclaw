/** JSON codec for cron delivery configuration and explicit destination clears. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronDelivery } from "../types.js";

const FAILURE_DESTINATION_FIELDS = ["channel", "to", "accountId", "mode"] as const;

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

/** Encodes explicitly undefined failure overrides as durable JSON null values. */
export function deliveryToJson(delivery: CronDelivery): Record<string, unknown> {
  const failureDestination = delivery.failureDestination;
  if (!failureDestination) {
    return { ...delivery };
  }
  return {
    ...delivery,
    failureDestination: Object.fromEntries(
      FAILURE_DESTINATION_FIELDS.filter((field) => Object.hasOwn(failureDestination, field)).map(
        (field) => [field, failureDestination[field] ?? null],
      ),
    ),
  };
}

/** Restores JSON null overrides as present-but-undefined runtime properties. */
export function deliveryFromJson(value: unknown): CronDelivery | undefined {
  if (!isRecord(value) || !hasCanonicalCronDeliveryMode(value)) {
    return undefined;
  }
  const failureDestination = value.failureDestination;
  if (!isRecord(failureDestination)) {
    return value as CronDelivery;
  }
  return {
    ...value,
    failureDestination: Object.fromEntries(
      FAILURE_DESTINATION_FIELDS.filter((field) => Object.hasOwn(failureDestination, field)).map(
        (field) => [field, failureDestination[field] ?? undefined],
      ),
    ),
  } as CronDelivery;
}
