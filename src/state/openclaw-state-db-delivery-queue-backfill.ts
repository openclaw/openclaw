import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { deriveDeliveryQueueRetentionColumns } from "../infra/delivery-queue-retention-columns.js";
import { pruneDeliveryQueueTombstones } from "../infra/delivery-queue-sqlite-bound.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "../infra/delivery-queue-sqlite.types.js";

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

/** Compact every preexisting failed row without inferring replay or owner policy. */
export function compactLegacyDeliveryQueueFailures(db: DatabaseSync): void {
  const migrationNow = Date.now();
  const retainPending = db.prepare(
    `UPDATE delivery_queue_entries SET entry_json = @entryJson,
      retention_id_prefix = @retention_id_prefix, retention_max_age_ms = @retention_max_age_ms,
      retention_max_entries = @retention_max_entries
      WHERE queue_name = @queueName AND id = @id AND status = 'pending' AND entry_json = @previousJson`,
  );
  const select = db.prepare(
    `SELECT queue_name, id, status, retry_count, entry_json, updated_at, failed_at, recovery_state
       FROM delivery_queue_entries WHERE status IN ('pending', 'failed')`,
  );
  select.setReadBigInts(true);
  const rows = select.all() as Array<Record<string, unknown>>;
  const remove = db.prepare(
    `DELETE FROM delivery_queue_entries WHERE queue_name = ? AND id = ? AND status = 'failed'`,
  );
  const compact = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = NULL, session_key = NULL, channel = NULL, target = NULL,
            account_id = NULL, retry_count = @retryCount, last_attempt_at = NULL,
            last_error = NULL, platform_send_started_at = NULL, entry_json = @entryJson,
            retention_id_prefix = @retention_id_prefix, retention_max_age_ms = @retention_max_age_ms,
            retention_max_entries = @retention_max_entries,
            enqueued_at = @failedAt, failed_at = @failedAt, recovery_state = @recoveryState
      WHERE queue_name = @queueName AND id = @id AND status = 'failed'`,
  );
  for (const row of rows) {
    // Failed send custody can still own a restartable completion projection.
    if (row.recovery_state === "settlement_pending") {
      continue;
    }
    const parsedEntry = safeParseJsonRecord(String(row.entry_json));
    const entry = parsedEntry ?? {};
    const queueName = String(row.queue_name);
    const id = String(row.id);
    if (row.status === "pending") {
      if (
        entry.retainOnFailure !== true &&
        inferDeliveryQueueFailureRetention(entry, id, queueName, true)
      ) {
        const entryJson = JSON.stringify({ ...entry, retainOnFailure: true });
        retainPending.run({
          entryJson,
          queueName,
          id,
          previousJson: String(row.entry_json),
          ...deriveDeliveryQueueRetentionColumns(id, entryJson),
        });
      }
      continue;
    }
    const failedAt =
      nonNegativeSafeInteger(row.failed_at) ??
      nonNegativeSafeInteger(row.updated_at) ??
      migrationNow;
    const retryCount = Math.max(
      nonNegativeSafeInteger(row.retry_count) ?? 0,
      nonNegativeSafeInteger(entry.retryCount) ?? 0,
    );
    const retention = parsedEntry
      ? inferDeliveryQueueFailureRetention(entry, id, queueName, true)
      : "permanent";
    if (!retention) {
      remove.run(queueName, id);
      continue;
    }
    const failedEntry = projectDeliveryQueueTerminalEntry(
      { id, retryCount },
      failedAt,
      "failed",
      retention,
    );
    const entryJson = JSON.stringify(failedEntry);
    compact.run({
      retryCount,
      entryJson,
      ...deriveDeliveryQueueRetentionColumns(id, entryJson),
      failedAt,
      recoveryState: failedEntry.recoveryState ?? null,
      queueName,
      id,
    });
  }
  pruneDeliveryQueueTombstones(db, migrationNow);
}
