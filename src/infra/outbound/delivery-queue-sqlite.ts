/**
 * SQLite adapter for the delivery queue.
 *
 * Maps between the in-memory `QueuedDelivery` format and the `delivery_queue`
 * table in operator1.db.
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../state-db/connection.js";
import { runMigrations } from "../state-db/schema.js";
import type { QueuedDelivery } from "./delivery-queue.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setDeliveryQueueDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetDeliveryQueueDbForTest(): void {
  _dbOverride = null;
}

export function initDeliveryQueueTestDb(db: DatabaseSync): DatabaseSync {
  runMigrations(db);
  setDeliveryQueueDbForTest(db);
  return db;
}

function resolveDb(db?: DatabaseSync): DatabaseSync {
  return db ?? _dbOverride ?? getStateDb();
}

// ── Row ↔ QueuedDelivery mapping ────────────────────────────────────────────

type DeliveryQueueRow = {
  queue_id: string;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number | null;
  last_attempted_at: number | null;
  created_at: number;
  delivered_at: number | null;
  failed_at: number | null;
  error: string | null;
};

function rowToQueuedDelivery(row: DeliveryQueueRow): QueuedDelivery {
  const payload = JSON.parse(row.payload_json);
  return {
    id: row.queue_id,
    enqueuedAt: row.created_at,
    retryCount: row.attempts,
    lastAttemptAt: row.last_attempted_at ?? undefined,
    lastError: row.error ?? undefined,
    ...payload,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function enqueueDeliveryToDb(entry: QueuedDelivery, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  const { id, enqueuedAt, retryCount, lastAttemptAt, lastError, ...payload } = entry;

  try {
    conn
      .prepare(
        `INSERT INTO delivery_queue (
          queue_id, payload_json, status, attempts, max_attempts,
          next_attempt_at, last_attempted_at, created_at, error
        ) VALUES (?, ?, 'pending', ?, 5, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(payload),
        retryCount,
        lastAttemptAt ?? null,
        enqueuedAt,
        lastError ?? null,
      );
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function ackDeliveryInDb(id: string, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  try {
    conn
      .prepare(
        "UPDATE delivery_queue SET status = 'delivered', delivered_at = ? WHERE queue_id = ?",
      )
      .run(Date.now(), id);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function failDeliveryInDb(
  id: string,
  error: string,
  nextAttemptAt?: number,
  db?: DatabaseSync,
): void {
  const conn = resolveDb(db);
  try {
    conn
      .prepare(
        `UPDATE delivery_queue
         SET attempts = attempts + 1,
             last_attempted_at = ?,
             error = ?,
             next_attempt_at = ?
         WHERE queue_id = ?`,
      )
      .run(Date.now(), error, nextAttemptAt ?? null, id);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function moveToFailedInDb(id: string, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  try {
    conn
      .prepare("UPDATE delivery_queue SET status = 'failed', failed_at = ? WHERE queue_id = ?")
      .run(Date.now(), id);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function loadPendingDeliveriesFromDb(db?: DatabaseSync): QueuedDelivery[] {
  const conn = resolveDb(db);
  try {
    const rows = conn
      .prepare("SELECT * FROM delivery_queue WHERE status = 'pending'")
      .all() as DeliveryQueueRow[];
    return rows.map(rowToQueuedDelivery);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export function loadDeliveryByIdFromDb(id: string, db?: DatabaseSync): QueuedDelivery | null {
  const conn = resolveDb(db);
  try {
    const row = conn.prepare("SELECT * FROM delivery_queue WHERE queue_id = ?").get(id) as
      | DeliveryQueueRow
      | undefined;
    return row ? rowToQueuedDelivery(row) : null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function deleteDeliveryFromDb(id: string, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  try {
    conn.prepare("DELETE FROM delivery_queue WHERE queue_id = ?").run(id);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}
