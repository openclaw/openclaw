import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  mentionStoreHeadSchema,
  mentionStoreSourceSchema,
  type MentionStoreHead,
  type MentionStoreSource,
  type MentionStoreSnapshot,
} from "./mention-inbox-store.codec.js";

export const MENTION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MAX_MENTION_SOURCES = 10_000;

const HEAD_KEY = "notifications.mentions.head";
const SOURCE_PREFIX = "notifications.mentions.source.";
const SOURCE_END = "notifications.mentions.source/";
/** The existing machine-state primary key owns lookup; this feature creates no schema. */
export function readMentionStoreSnapshotInDatabase(
  revision: number,
  database: DatabaseSync,
): MentionStoreSnapshot | undefined {
  return runSqliteDeferredTransactionSync(database, () =>
    readMentionStoreSnapshotRows(revision, database),
  );
}

function readMentionStoreSnapshotRows(
  revision: number,
  database: DatabaseSync,
): MentionStoreSnapshot | undefined {
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const headRow = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("config_machine_state").select("value_json").where("state_key", "=", HEAD_KEY),
  );
  const head = headRow
    ? mentionStoreHeadSchema.parse(JSON.parse(headRow.value_json))
    : { revision: 0, nextSequence: 0 };
  if (head.revision === revision) {
    return undefined;
  }
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where("state_key", ">=", SOURCE_PREFIX)
      .where("state_key", "<", SOURCE_END)
      .limit(MAX_MENTION_SOURCES + 1),
  ).rows;
  if (rows.length > MAX_MENTION_SOURCES) {
    throw new Error("Mention retention exceeds its source budget");
  }
  const ids = new Set<string>();
  const sequences = new Set<number>();
  let itemCount = 0;
  const sources = rows.map((row) => {
    // Reject unreadable state instead of overwriting it with an empty Inbox.
    if (row.value_json.length > 32_768) {
      throw new Error("Mention source exceeds its record budget");
    }
    const source = mentionStoreSourceSchema.parse(JSON.parse(row.value_json));
    if (
      row.state_key !== `${SOURCE_PREFIX}${source.key}` ||
      source.sequence >= head.nextSequence ||
      sequences.has(source.sequence) ||
      new Set(source.recipients.map(([profileId]) => profileId)).size !== source.recipients.length
    ) {
      throw new Error("Invalid mention source identity");
    }
    const excerpts = source.message?.recipientExcerpts ?? [];
    const retainedProfiles = new Set(
      source.recipients.filter(([, id]) => id !== null).map(([profileId]) => profileId),
    );
    if (
      new Set(excerpts.map(({ profileId }) => profileId)).size !== excerpts.length ||
      excerpts.some(({ profileId }) => !retainedProfiles.has(profileId))
    ) {
      throw new Error("Invalid mention excerpt recipient");
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
      itemCount++;
    }
    if (
      source.message &&
      source.expiresAt !== source.message.content.createdAt + MENTION_RETENTION_MS
    ) {
      throw new Error("Invalid mention retention window");
    }
    return source;
  });
  if (itemCount > MAX_MENTION_SOURCES) {
    throw new Error("Mention retention exceeds its item budget");
  }
  return { head, sources: sources.toSorted((left, right) => left.sequence - right.sequence) };
}

export async function readMentionStoreSnapshot(
  revision: number,
  context: OpenClawStateWorkerContext,
): Promise<MentionStoreSnapshot | undefined> {
  const result = await executeExistingOpenClawStateRead(
    { env: context.environment, path: context.admission.databasePath },
    { type: "mentions.snapshot", revision },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (result?.ok && result.type === "mentions.snapshot") {
    return result.snapshot;
  }
  if (!result) {
    return revision === 0 ? undefined : { head: { revision: 0, nextSequence: 0 }, sources: [] };
  }
  throw new Error("Mention Inbox snapshot unavailable");
}

/** Called inside the admitting Inbox's synchronous shared-state write transaction. */
export function writeMentionStoreChanges(
  database: DatabaseSync,
  head: MentionStoreHead,
  changes: ReadonlyMap<string, MentionStoreSource | undefined>,
): MentionStoreHead {
  if (changes.size === 0) {
    return head;
  }
  const next = mentionStoreHeadSchema.parse({ ...head, revision: head.revision + 1 });
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const updatedAtMs = Date.now();
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
    const valueJson = JSON.stringify(source);
    if (valueJson.length > 32_768) {
      throw new Error("Mention source exceeds its record budget");
    }
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
  }
  flushDeletes();
  executeSqliteQuerySync(
    database,
    db
      .insertInto("config_machine_state")
      .values({ state_key: HEAD_KEY, value_json: JSON.stringify(next), updated_at_ms: updatedAtMs })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: JSON.stringify(next),
          updated_at_ms: updatedAtMs,
        }),
      ),
  );
  return next;
}
