import type { SQLInputValue } from "node:sqlite";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.types.js";

type SqliteBindRow = Record<string, SQLInputValue>;

export function buildLegacyDeliveryQueueRow(params: {
  queueName: string;
  id: string;
  status: "pending" | "failed";
  entry: Record<string, unknown>;
  now: number;
}): (SqliteBindRow & { id: string }) | null {
  const originalEnqueuedAt =
    asSafeIntegerInRange(params.entry.enqueuedAt, { min: 0 }) ?? params.now;
  const retryCount = asSafeIntegerInRange(params.entry.retryCount, { min: 0 }) ?? 0;
  const lastAttemptAt = asSafeIntegerInRange(params.entry.lastAttemptAt, { min: 0 });
  const platformSendStartedAt = asSafeIntegerInRange(params.entry.platformSendStartedAt, {
    min: 0,
  });
  const failed = params.status === "failed";
  const retention = failed
    ? inferDeliveryQueueFailureRetention(params.entry, params.id, params.queueName)
    : undefined;
  if (failed && !retention) {
    return null;
  }
  const failedAt = failed
    ? (asSafeIntegerInRange(params.entry.failedAt, { min: 0 }) ??
      lastAttemptAt ??
      originalEnqueuedAt)
    : null;
  const enqueuedAt = failedAt ?? originalEnqueuedAt;
  const retainedEntry = {
    ...params.entry,
    id: params.id,
    enqueuedAt,
    retryCount,
    lastAttemptAt,
    platformSendStartedAt,
    lastError: typeof params.entry.lastError === "string" ? params.entry.lastError : undefined,
    recoveryState:
      typeof params.entry.recoveryState === "string" ? params.entry.recoveryState : undefined,
  };
  const failedEntry = failed
    ? projectDeliveryQueueTerminalEntry(
        { id: params.id, retryCount },
        enqueuedAt,
        "failed",
        retention,
      )
    : undefined;
  return {
    ...bindDeliveryQueueEntry(
      {
        queueName: params.queueName,
        entry: failedEntry ?? retainedEntry,
        status: params.status,
        ...(failed ? { metadata: {} } : {}),
      },
      params.now,
    ).row,
    // Import preserves historical failure time; live queue failures use the current time.
    failed_at: failedAt,
  };
}

export function legacyDeliveryQueueRowsMatch(
  existing: Record<string, unknown>,
  incoming: SqliteBindRow,
): boolean {
  return [
    "status",
    "entry_kind",
    "session_key",
    "channel",
    "target",
    "account_id",
    "retry_count",
    "last_attempt_at",
    "last_error",
    "recovery_state",
    "platform_send_started_at",
    "entry_json",
    "enqueued_at",
    "failed_at",
  ].every((column) => {
    const left = existing[column];
    const right = incoming[column];
    return (
      (typeof left === "bigint" ? Number(left) : left) ===
      (typeof right === "bigint" ? Number(right) : right)
    );
  });
}
