import type { CronDelivery } from "../types.js";
import { booleanToInteger, integerToBoolean } from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

export function bindDeliveryColumns(
  delivery: CronDelivery | undefined,
): Pick<
  CronJobInsert,
  | "delivery_account_id"
  | "delivery_best_effort"
  | "delivery_channel"
  | "delivery_completion_mode"
  | "delivery_completion_to"
  | "delivery_mode"
  | "delivery_thread_id"
  | "delivery_to"
  | "failure_delivery_account_id"
  | "failure_delivery_channel"
  | "failure_delivery_mode"
  | "failure_delivery_to"
> {
  return {
    delivery_mode: delivery?.mode ?? null,
    delivery_channel: delivery?.channel ?? null,
    delivery_to: delivery?.to ?? null,
    delivery_thread_id:
      delivery?.threadId === undefined || delivery.threadId === null
        ? null
        : String(delivery.threadId),
    delivery_account_id: delivery?.accountId ?? null,
    delivery_best_effort: booleanToInteger(delivery?.bestEffort),
    delivery_completion_mode: delivery?.completionDestination?.mode ?? null,
    delivery_completion_to: delivery?.completionDestination?.to ?? null,
    failure_delivery_mode: delivery?.failureDestination?.mode ?? null,
    failure_delivery_channel: delivery?.failureDestination?.channel ?? null,
    failure_delivery_to: delivery?.failureDestination?.to ?? null,
    failure_delivery_account_id: delivery?.failureDestination?.accountId ?? null,
  };
}

function cronDeliveryModeFromValue(value: unknown): CronDelivery["mode"] | undefined {
  return value === "none" || value === "announce" || value === "webhook" ? value : undefined;
}

export function deliveryFromRow(row: CronJobRow): CronDelivery | undefined {
  const rowMode = cronDeliveryModeFromValue(row.delivery_mode);
  const hasDeliveryColumns =
    Boolean(
      row.delivery_channel ||
      row.delivery_to ||
      row.delivery_thread_id ||
      row.delivery_account_id ||
      row.delivery_completion_mode ||
      row.delivery_completion_to ||
      row.failure_delivery_channel ||
      row.failure_delivery_to ||
      row.failure_delivery_mode ||
      row.failure_delivery_account_id,
    ) || row.delivery_best_effort != null;
  const completionDestination =
    rowMode === "announce" && row.delivery_completion_mode === "webhook"
      ? {
          mode: "webhook" as const,
          ...(row.delivery_completion_to ? { to: row.delivery_completion_to } : {}),
        }
      : undefined;
  const failureDestination =
    row.failure_delivery_channel ||
    row.failure_delivery_to ||
    row.failure_delivery_mode ||
    row.failure_delivery_account_id
      ? {
          ...(row.failure_delivery_channel
            ? { channel: row.failure_delivery_channel as CronDelivery["channel"] }
            : {}),
          ...(row.failure_delivery_to ? { to: row.failure_delivery_to } : {}),
          ...(row.failure_delivery_mode
            ? { mode: row.failure_delivery_mode as "announce" | "webhook" }
            : {}),
          ...(row.failure_delivery_account_id
            ? { accountId: row.failure_delivery_account_id }
            : {}),
        }
      : undefined;
  if (!rowMode && !hasDeliveryColumns) {
    return undefined;
  }
  return {
    mode: rowMode ?? "announce",
    ...(row.delivery_channel ? { channel: row.delivery_channel as CronDelivery["channel"] } : {}),
    ...(row.delivery_to ? { to: row.delivery_to } : {}),
    ...(row.delivery_thread_id ? { threadId: row.delivery_thread_id } : {}),
    ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
    ...(row.delivery_best_effort != null
      ? { bestEffort: integerToBoolean(row.delivery_best_effort) }
      : {}),
    ...(completionDestination ? { completionDestination } : {}),
    ...(failureDestination ? { failureDestination } : {}),
  };
}
