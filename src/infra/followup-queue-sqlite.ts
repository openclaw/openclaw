import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
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

function databaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function openQueueDatabase(stateDir?: string) {
  return openOpenClawStateDatabase(databaseOptions(stateDir));
}

export function replaceFollowupQueueEntries(params: {
  entries: Array<[string, unknown]>;
  stateDir?: string;
}): void {
  const now = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
    const nextKeys = new Set(params.entries.map(([key]) => key));
    if (nextKeys.size === 0) {
      executeSqliteQuerySync(database.db, queueDb.deleteFrom("followup_queue_entries"));
      return;
    }
    const existing = executeSqliteQuerySync(
      database.db,
      queueDb.selectFrom("followup_queue_entries").select(["queue_key"]),
    ).rows as Array<{ queue_key: string }>;
    for (const row of existing) {
      if (!nextKeys.has(row.queue_key)) {
        executeSqliteQuerySync(
          database.db,
          queueDb.deleteFrom("followup_queue_entries").where("queue_key", "=", row.queue_key),
        );
      }
    }
    for (const [queueKey, queueData] of params.entries) {
      executeSqliteQuerySync(
        database.db,
        queueDb
          .insertInto("followup_queue_entries")
          .values({
            queue_key: queueKey,
            queue_json: JSON.stringify(queueData),
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("queue_key").doUpdateSet({
              queue_json: (eb) => eb.ref("excluded.queue_json"),
              updated_at: (eb) => eb.ref("excluded.updated_at"),
            }),
          ),
      );
    }
  }, databaseOptions(params.stateDir));
}

export function loadFollowupQueueEntries(stateDir?: string): Array<[string, unknown]> {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_key", "queue_json", "updated_at"])
      .orderBy("updated_at", "asc")
      .orderBy("queue_key", "asc"),
  ).rows as FollowupQueueRow[];
  return rows.map((row) => [row.queue_key, JSON.parse(row.queue_json) as unknown]);
}

export function hasFollowupQueueEntries(stateDir?: string): boolean {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select((eb) => eb.fn.countAll<number>().as("count")),
  ) as { count?: number | bigint } | undefined;
  return Number(row?.count ?? 0) > 0;
}

export function followupQueueEntryContainsPrompt(
  queueKey: string,
  prompt: string,
  stateDir?: string,
): boolean {
  const database = openQueueDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<FollowupQueueDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("followup_queue_entries")
      .select(["queue_json"])
      .where("queue_key", "=", queueKey),
  ) as { queue_json?: string } | undefined;
  return row?.queue_json?.includes(prompt) === true;
}
