import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
} from "../infra/sqlite-database-admission.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  MAX_MENTION_SOURCES,
  MENTION_RETENTION_MS,
  mentionStoreHeadAdmission as headAdmission,
  mentionStoreHeadSchema as headSchema,
  mentionStoreSourceSchema as sourceSchema,
  type MentionStoreHead,
  type MentionStoreSnapshot,
  type MentionStoreSource,
} from "./mention-inbox-store.js";

type ConfigMachineStateDatabase = Pick<StateDatabase, "config_machine_state">;

const HEAD_KEY = "notifications.mentions.head";
const SOURCE_PREFIX = "notifications.mentions.source.";
const SOURCE_END = "notifications.mentions.source/";

/** The existing machine-state primary key owns lookup; this feature creates no schema. */
export function readMentionStoreHead(database: DatabaseSync): MentionStoreHead {
  const admitted = getSqliteDatabaseAdmission(database, headAdmission);
  if (admitted) {
    return admitted;
  }
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const headRow = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("config_machine_state").select("value_json").where("state_key", "=", HEAD_KEY),
  );
  const head = headRow
    ? headSchema.parse(JSON.parse(headRow.value_json))
    : { revision: 0, nextSequence: 0 };
  publishSqliteDatabaseAdmission(database, headAdmission, head);
  return head;
}

export function readMentionStoreSnapshot(
  revision: number,
  database: DatabaseSync,
): MentionStoreSnapshot | undefined {
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  if (getSqliteDatabaseAdmission(database, headAdmission)?.revision === revision) {
    return undefined;
  }
  // Header and sources belong to one native statement snapshot, including forced repair.
  const snapshotRows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where((eb) =>
        eb.or([
          eb("state_key", "=", HEAD_KEY),
          eb.and([eb("state_key", ">=", SOURCE_PREFIX), eb("state_key", "<", SOURCE_END)]),
        ]),
      )
      .limit(MAX_MENTION_SOURCES + 2),
  ).rows;
  const header = snapshotRows.find((row) => row.state_key === HEAD_KEY);
  const head = header
    ? headSchema.parse(JSON.parse(header.value_json))
    : { revision: 0, nextSequence: 0 };
  const current = getSqliteDatabaseAdmission(database, headAdmission);
  if (!current || current.revision <= head.revision) {
    publishSqliteDatabaseAdmission(database, headAdmission, head);
  }
  if (head.revision === revision) {
    return undefined;
  }
  const rows = snapshotRows.filter((row) => row.state_key !== HEAD_KEY);
  if (rows.length > MAX_MENTION_SOURCES) {
    throw new Error("Mention retention exceeds its source budget");
  }
  const ids = new Set<string>();
  const sequences = new Set<number>();
  const sources = rows.map((row) => {
    // Reject unreadable state instead of overwriting it with an empty Inbox.
    if (row.value_json.length > 32_768) {
      throw new Error("Mention source exceeds its record budget");
    }
    const source = sourceSchema.parse(JSON.parse(row.value_json));
    if (
      row.state_key !== `${SOURCE_PREFIX}${source.key}` ||
      source.sequence >= head.nextSequence ||
      sequences.has(source.sequence) ||
      new Set(source.recipients.map(([profileId]) => profileId)).size !== source.recipients.length
    ) {
      throw new Error("Invalid mention source identity");
    }
    sequences.add(source.sequence);
    for (const [, id] of source.recipients) {
      if (id === null) {
        continue;
      }
      if (!source.message || ids.has(id)) {
        throw new Error("Invalid retained mention");
      }
      ids.add(id);
    }
    if (
      source.message &&
      source.expiresAt !== source.message.content.createdAt + MENTION_RETENTION_MS
    ) {
      throw new Error("Invalid mention retention window");
    }
    return source;
  });
  if (ids.size > MAX_MENTION_SOURCES) {
    throw new Error("Mention retention exceeds its item budget");
  }
  return { head, sources: sources.toSorted((left, right) => left.sequence - right.sequence) };
}

/** Called only inside the owning SQLite write transaction. */
export function writeMentionStoreChanges(
  database: DatabaseSync,
  head: MentionStoreHead,
  changes: ReadonlyMap<string, MentionStoreSource | undefined>,
): MentionStoreHead {
  if (changes.size === 0) {
    return head;
  }
  const next = headSchema.parse({ ...head, revision: head.revision + 1 });
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const updatedAtMs = Date.now();
  const writeValue = (stateKey: string, valueJson: string) =>
    executeSqliteQuerySync(
      database,
      db
        .insertInto("config_machine_state")
        .values({ state_key: stateKey, value_json: valueJson, updated_at_ms: updatedAtMs })
        .onConflict((conflict) =>
          conflict.column("state_key").doUpdateSet({
            value_json: valueJson,
            updated_at_ms: updatedAtMs,
          }),
        ),
    );
  const deletedKeys: string[] = [];
  const flushDeletes = () => {
    if (deletedKeys.length === 0) {
      return;
    }
    const deletion = db.deleteFrom("config_machine_state");
    executeSqliteQuerySync(
      database,
      deletedKeys.length === 1
        ? deletion.where("state_key", "=", deletedKeys[0]!)
        : deletion.where("state_key", "in", sqliteStringSet(deletedKeys)),
    );
    deletedKeys.length = 0;
  };
  for (const [key, source] of changes) {
    const stateKey = `${SOURCE_PREFIX}${key}`;
    if (!source) {
      deletedKeys.push(stateKey);
      continue;
    }
    flushDeletes();
    writeValue(stateKey, JSON.stringify(source));
  }
  flushDeletes();
  writeValue(HEAD_KEY, JSON.stringify(next));
  publishSqliteDatabaseAdmission(database, headAdmission, next);
  return next;
}
