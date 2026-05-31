import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CronCompletionDestination, CronDelivery, CronMessageChannel } from "../types.js";
import {
  booleanToInteger,
  integerToBoolean,
  optionalBooleanFromRecord,
  optionalStringFromRecord,
  optionalThreadIdFromRecord,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

export function bindDeliveryColumns(
  delivery: CronDelivery | undefined,
): Pick<
  CronJobInsert,
  | "delivery_account_id"
  | "delivery_best_effort"
  | "delivery_channel"
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
    failure_delivery_mode: delivery?.failureDestination?.mode ?? null,
    failure_delivery_channel: delivery?.failureDestination?.channel ?? null,
    failure_delivery_to: delivery?.failureDestination?.to ?? null,
    failure_delivery_account_id: delivery?.failureDestination?.accountId ?? null,
  };
}

function cronDeliveryModeFromValue(value: unknown): CronDelivery["mode"] | undefined {
  return value === "none" || value === "announce" || value === "webhook" ? value : undefined;
}

function cronFailureDeliveryModeFromValue(value: unknown): "announce" | "webhook" | undefined {
  return value === "announce" || value === "webhook" ? value : undefined;
}

function completionDestinationFromFallback(params: {
  fallback: unknown;
  mode: CronDelivery["mode"] | undefined;
}): CronCompletionDestination | undefined {
  if (params.mode !== "announce") {
    return undefined;
  }
  const { fallback } = params;
  if (!isRecord(fallback)) {
    return undefined;
  }
  const raw = fallback.completionDestination;
  if (!isRecord(raw) || raw.mode !== "webhook") {
    return undefined;
  }
  const to = optionalStringFromRecord(raw, "to");
  return {
    mode: "webhook",
    ...(to ? { to } : {}),
  };
}

function failureDestinationFromFallback(
  fallback: unknown,
): CronDelivery["failureDestination"] | undefined {
  if (!isRecord(fallback)) {
    return undefined;
  }
  const raw = fallback.failureDestination;
  if (!isRecord(raw)) {
    return undefined;
  }
  const mode = cronFailureDeliveryModeFromValue(raw.mode);
  const channel = optionalStringFromRecord(raw, "channel") as CronMessageChannel | undefined;
  const to = optionalStringFromRecord(raw, "to");
  const accountId = optionalStringFromRecord(raw, "accountId");
  if (!mode && !channel && !to && !accountId) {
    return undefined;
  }
  return {
    ...(mode ? { mode } : {}),
    ...(channel ? { channel } : {}),
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function fallbackDeliveryFromRecord(fallback: unknown): CronDelivery | undefined {
  if (!isRecord(fallback)) {
    return undefined;
  }
  const mode = cronDeliveryModeFromValue(fallback.mode);
  const channel = optionalStringFromRecord(fallback, "channel") as CronMessageChannel | undefined;
  const to = optionalStringFromRecord(fallback, "to");
  const threadId = optionalThreadIdFromRecord(fallback, "threadId");
  const accountId = optionalStringFromRecord(fallback, "accountId");
  const bestEffort = optionalBooleanFromRecord(fallback, "bestEffort");
  const completionDestination = completionDestinationFromFallback({
    fallback,
    mode: mode ?? "announce",
  });
  const failureDestination = failureDestinationFromFallback(fallback);
  if (
    !mode &&
    !channel &&
    !to &&
    threadId == null &&
    !accountId &&
    bestEffort == null &&
    !completionDestination &&
    !failureDestination
  ) {
    return undefined;
  }
  return {
    mode: mode ?? "announce",
    ...(channel ? { channel } : {}),
    ...(to ? { to } : {}),
    ...(threadId != null ? { threadId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(bestEffort != null ? { bestEffort } : {}),
    ...(completionDestination ? { completionDestination } : {}),
    ...(failureDestination ? { failureDestination } : {}),
  };
}

export function deliveryFromRow(row: CronJobRow, fallback?: unknown): CronDelivery | undefined {
  const fallbackDelivery = fallbackDeliveryFromRecord(fallback);
  const rowMode = cronDeliveryModeFromValue(row.delivery_mode);
  const mode = rowMode ?? fallbackDelivery?.mode;
  const hasDeliveryColumns =
    Boolean(
      row.delivery_channel ||
      row.delivery_to ||
      row.delivery_thread_id ||
      row.delivery_account_id ||
      row.failure_delivery_channel ||
      row.failure_delivery_to ||
      row.failure_delivery_mode ||
      row.failure_delivery_account_id,
    ) || row.delivery_best_effort != null;
  const completionDestination =
    mode === "announce" ? fallbackDelivery?.completionDestination : undefined;
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
      : fallbackDelivery?.failureDestination;
  if (!mode && !hasDeliveryColumns && !fallbackDelivery) {
    return undefined;
  }
  const fallbackDeliveryFields =
    rowMode === "none" || rowMode === "webhook"
      ? {}
      : {
          ...(fallbackDelivery?.channel ? { channel: fallbackDelivery.channel } : {}),
          ...(fallbackDelivery?.to ? { to: fallbackDelivery.to } : {}),
          ...(fallbackDelivery?.threadId != null ? { threadId: fallbackDelivery.threadId } : {}),
          ...(fallbackDelivery?.accountId ? { accountId: fallbackDelivery.accountId } : {}),
          ...(fallbackDelivery?.bestEffort != null
            ? { bestEffort: fallbackDelivery.bestEffort }
            : {}),
        };
  return {
    ...fallbackDeliveryFields,
    mode: mode ?? "announce",
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
