/**
 * In-database follow-up queue storage.
 *
 * One owner for the SQL itself, shared by the shared-state worker handler (the
 * runtime path) and by direct callers that already hold an open database. Nothing
 * here decides *where* it runs; `followup-queue-sqlite.ts` owns that.
 */
import type { DatabaseSync } from "node:sqlite";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type FollowupQueueDatabase = Pick<OpenClawStateKyselyDatabase, "followup_queue_entries">;

type FollowupQueueRow = {
  queue_key: string;
  queue_json: string;
  updated_at: number | bigint;
};

function queueDbOf(db: DatabaseSync) {
  return getNodeSqliteKysely<FollowupQueueDatabase>(db);
}

export function listFollowupQueueKeysInDatabase(db: DatabaseSync): string[] {
  const queueDb = queueDbOf(db);
  return executeSqliteQuerySync(
    db,
    queueDb.selectFrom("followup_queue_entries").select(["queue_key"]).orderBy("queue_key", "asc"),
  ).rows.map((row) => row.queue_key);
}

/**
 * Read one queue row. `found: false` means the key has no row; a throw means the
 * database could not be read, so callers never mistake an unreadable row for an
 * absent one.
 */
export function loadFollowupQueueEntryInDatabase(
  db: DatabaseSync,
  queueKey: string,
): { found: boolean; data: unknown } {
  const queueDb = queueDbOf(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_json"])
      .where("queue_key", "=", queueKey),
  );
  if (row === undefined) {
    return { found: false, data: undefined };
  }
  return { found: true, data: JSON.parse(row.queue_json) as unknown };
}

function readFollowupQueueRowsInDatabase(db: DatabaseSync): FollowupQueueRow[] {
  const queueDb = queueDbOf(db);
  return executeSqliteQuerySync(
    db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_key", "queue_json", "updated_at"])
      .orderBy("updated_at", "asc")
      .orderBy("queue_key", "asc"),
  ).rows;
}

export function loadFollowupQueueEntriesInDatabase(db: DatabaseSync): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const row of readFollowupQueueRowsInDatabase(db)) {
    try {
      entries.push([row.queue_key, JSON.parse(row.queue_json) as unknown]);
    } catch (err) {
      // Skip only the corrupt row so one bad payload does not block the rest.
      console.warn(`Skipping corrupt followup queue entry ${row.queue_key}: ${String(err)}`);
    }
  }
  return entries;
}

/** Keys whose `queue_json` cannot be parsed. Ordinary persist must retain these. */
export function listUnreadableFollowupQueueKeysInDatabase(db: DatabaseSync): string[] {
  const unreadable: string[] = [];
  for (const row of readFollowupQueueRowsInDatabase(db)) {
    try {
      JSON.parse(row.queue_json);
    } catch {
      unreadable.push(row.queue_key);
    }
  }
  return unreadable;
}

export function hasFollowupQueueEntriesInDatabase(db: DatabaseSync): boolean {
  const queueDb = queueDbOf(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select((eb) => eb.fn.countAll<number>().as("count")),
  );
  return (row?.count ?? 0) > 0;
}

export function followupQueueEntryContainsPromptInDatabase(
  db: DatabaseSync,
  queueKey: string,
  prompt: string,
): boolean {
  const queueDb = queueDbOf(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_json"])
      .where("queue_key", "=", queueKey),
  );
  return row?.queue_json?.includes(prompt) === true;
}

/**
 * Replace the snapshot inside an open transaction.
 *
 * Absent keys are deleted unless retained, so a caller that could not read a row
 * keeps it. The caller owns the transaction, which is what preserves FIFO
 * settlement ordering and lets a failed write roll back admission.
 */
export function replaceFollowupQueueEntriesInDatabase(
  db: DatabaseSync,
  params: { entries: Array<[string, unknown]>; retainKeys?: readonly string[]; now: number },
): void {
  const queueDb = queueDbOf(db);
  const nextKeys = new Set(params.entries.map(([key]) => key));
  const retainKeys = new Set(params.retainKeys ?? []);
  if (nextKeys.size === 0 && retainKeys.size === 0) {
    executeSqliteQuerySync(db, queueDb.deleteFrom("followup_queue_entries"));
    return;
  }
  const existing = executeSqliteQuerySync(
    db,
    queueDb.selectFrom("followup_queue_entries").select(["queue_key"]),
  ).rows;
  for (const row of existing) {
    if (!nextKeys.has(row.queue_key) && !retainKeys.has(row.queue_key)) {
      executeSqliteQuerySync(
        db,
        queueDb.deleteFrom("followup_queue_entries").where("queue_key", "=", row.queue_key),
      );
    }
  }
  for (const [queueKey, queueData] of params.entries) {
    executeSqliteQuerySync(
      db,
      queueDb
        .insertInto("followup_queue_entries")
        .values({
          queue_key: queueKey,
          queue_json: JSON.stringify(queueData),
          updated_at: params.now,
        })
        .onConflict((conflict) =>
          conflict.column("queue_key").doUpdateSet({
            queue_json: (eb) => eb.ref("excluded.queue_json"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
  }
}
