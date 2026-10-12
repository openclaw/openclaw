import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MAX_HUMAN_MENTIONS } from "../../packages/gateway-protocol/src/index.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
type ConfigMachineStateDatabase = Pick<StateDatabase, "config_machine_state">;

export const MENTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_MENTION_SOURCES = 10_000;

const HEAD_KEY = "notifications.mentions.head";
const SOURCE_PREFIX = "notifications.mentions.source.";
const SOURCE_END = "notifications.mentions.source/";
const reference = z.string().min(1).max(256);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headSchema = z.object({ revision: timestamp, nextSequence: timestamp });
const messageSchema = z.object({
  sessionId: reference,
  content: z.object({
    senderProfileId: reference,
    sessionKey: z.string().min(1).max(512),
    agentId: reference,
    messageId: reference,
    createdAt: timestamp,
    excerpt: z.string().max(280).optional(),
  }),
});
const sourceSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: timestamp,
  expiresAt: timestamp,
  recipients: z.array(z.tuple([reference, reference.nullable()])).max(MAX_HUMAN_MENTIONS),
  message: messageSchema.optional(),
});

export type MentionStoreHead = z.infer<typeof headSchema>;
export type MentionStoreSource = z.infer<typeof sourceSchema>;
export type MentionStoreMessage = z.infer<typeof messageSchema>;
export type MentionStoreSnapshot = {
  head: MentionStoreHead;
  sources: MentionStoreSource[];
};

const headAdmission: SqliteDatabaseAdmissionKey<MentionStoreHead> = {
  name: "state.mention-head",
  read: (value) => headSchema.safeParse(value).data,
};

export function getMentionStoreHeadAdmission(databasePath: string): MentionStoreHead | undefined {
  return getOrLoadSqliteDatabaseAdmissionForPath(databasePath, headAdmission, () => undefined);
}

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
