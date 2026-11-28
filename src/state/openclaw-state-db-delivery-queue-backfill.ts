import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { deriveDeliveryQueueRetentionColumns } from "../infra/delivery-queue-retention-columns.js";
import {
  pruneDeliveryQueueTombstones,
  selectExpiredDeliveryQueueTombstones,
} from "../infra/delivery-queue-sqlite-bound.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "../infra/delivery-queue-sqlite.types.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";

function nonNegativeSafeInteger(value: unknown): number | undefined {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined;
}

type FailureCompaction =
  | { kind: "retain"; params: Record<string, string | number | null> }
  | { kind: "remove"; queueName: string; id: string }
  | { kind: "compact"; params: Record<string, string | number | null>; unchanged: boolean };

const COMPACTED_NULL_COLUMNS = [
  "entry_kind",
  "session_key",
  "channel",
  "target",
  "account_id",
  "last_attempt_at",
  "last_error",
  "platform_send_started_at",
] as const;

/** The row operations {@link compactLegacyDeliveryQueueFailures} applies, in row order. */
function* planLegacyDeliveryQueueFailureCompaction(
  db: DatabaseSync,
  migrationNow: number,
): Generator<FailureCompaction> {
  const select = db.prepare(
    `SELECT queue_name, id, status, retry_count, entry_json, updated_at, failed_at, recovery_state,
            enqueued_at, retention_id_prefix, retention_max_age_ms, retention_max_entries,
            ${COMPACTED_NULL_COLUMNS.join(", ")}
       FROM delivery_queue_entries WHERE status IN ('pending', 'failed')`,
  );
  select.setReadBigInts(true);
  const rows = select.all() as Array<Record<string, unknown>>;
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
        yield {
          kind: "retain",
          params: {
            entryJson,
            queueName,
            id,
            previousJson: String(row.entry_json),
            ...deriveDeliveryQueueRetentionColumns(id, entryJson),
          },
        };
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
      yield { kind: "remove", queueName, id };
      continue;
    }
    const failedEntry = projectDeliveryQueueTerminalEntry(
      { id, retryCount },
      failedAt,
      "failed",
      retention,
    );
    const entryJson = JSON.stringify(failedEntry);
    const retentionColumns = deriveDeliveryQueueRetentionColumns(id, entryJson);
    const recoveryState = failedEntry.recoveryState ?? null;
    const same = (column: string, value: string | number | null) =>
      (typeof row[column] === "bigint" ? Number(row[column]) : row[column]) === value;
    yield {
      kind: "compact",
      params: {
        retryCount,
        entryJson,
        ...retentionColumns,
        failedAt,
        recoveryState,
        queueName,
        id,
      },
      unchanged:
        COMPACTED_NULL_COLUMNS.every((column) => row[column] === null) &&
        same("retry_count", retryCount) &&
        same("entry_json", entryJson) &&
        same("retention_id_prefix", retentionColumns.retention_id_prefix) &&
        same("retention_max_age_ms", retentionColumns.retention_max_age_ms) &&
        same("retention_max_entries", retentionColumns.retention_max_entries) &&
        same("enqueued_at", failedAt) &&
        same("failed_at", failedAt) &&
        same("recovery_state", recoveryState),
    };
  }
}

/**
 * Read-only: whether {@link compactLegacyDeliveryQueueFailures} at `now` would change a row:
 * retain a pending row, remove or rewrite a failed one, or prune an expired receipt.
 */
export function hasLegacyDeliveryQueueFailureCompactionWork(
  db: DatabaseSync,
  now: number,
): boolean {
  for (const operation of planLegacyDeliveryQueueFailureCompaction(db, now)) {
    if (operation.kind !== "compact" || !operation.unchanged) {
      return true;
    }
  }
  return selectExpiredDeliveryQueueTombstones(db, now).some(
    (query) => executeSqliteQuerySync(db, query).rows.length > 0,
  );
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
  // The planner reads every row before yielding, so these writes cannot change its input.
  for (const operation of planLegacyDeliveryQueueFailureCompaction(db, migrationNow)) {
    if (operation.kind === "retain") {
      retainPending.run(operation.params);
    } else if (operation.kind === "remove") {
      remove.run(operation.queueName, operation.id);
    } else {
      compact.run(operation.params);
    }
  }
  pruneDeliveryQueueTombstones(db, migrationNow);
}
