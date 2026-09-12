import type { CompiledQuery } from "kysely";
import { iterateSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  sessionEntryInventoryJson,
} from "./session-accessor.sqlite-status.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export function readSessionEntryStore(
  database: OpenClawAgentDatabase,
  options: {
    allowCanonicalRepair?: boolean;
    includeArchived?: boolean;
    sessionKeys?: readonly string[];
  } = {},
): Record<string, SessionEntry> {
  if (options.allowCanonicalRepair !== true) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const db = getSessionKysely(database.db);
  let query = db.selectFrom("session_nodes").selectAll();
  if (options.includeArchived === false) {
    query = query.where("archived_at", "is", null);
  }
  const rows = iterateSqliteQuerySync(
    database.db,
    (options.sessionKeys
      ? query.where("session_key", "in", sqliteStringSet(options.sessionKeys))
      : query
    ).orderBy("session_key"),
  );
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    // Doctor lifecycle projection supplies its separately hydrated expected entry for rejected
    // raw rows; ordinary exact reads still fail loud before a write can replace one.
    const entry = parseSessionEntryJson(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

type SessionEntryCountRow = { count: number; entry_json: string | null };

const countQueriesByDatabase = new WeakMap<
  OpenClawAgentDatabase["db"],
  Map<boolean, CompiledQuery<SessionEntryCountRow>>
>();

export function readSessionEntryCount(
  database: OpenClawAgentDatabase,
  options: { includeArchived?: boolean } = {},
): number {
  const includeArchived = options.includeArchived !== false;
  let queries = countQueriesByDatabase.get(database.db);
  let compiled = queries?.get(includeArchived);
  if (!compiled) {
    const db = getSessionKysely(database.db);
    let query = db.selectFrom("session_nodes");
    if (!includeArchived) {
      query = query.where("archived_at", "is", null);
    }
    // One statement preserves the snapshot while settled rows stay inside SQLite.
    compiled = query
      .where("entry_valid", "=", 1)
      .select((eb) => [
        eb.fn.countAll<number>().as("count"),
        eb.val<string | null>(null).as("entry_json"),
      ])
      .unionAll(
        query
          .where("entry_valid", "!=", 1)
          .select((eb) => eb.val(0).as("count"))
          .select(sessionEntryInventoryJson),
      )
      .compile();
    if (!queries) {
      queries = new Map();
      countQueriesByDatabase.set(database.db, queries);
    }
    queries.set(includeArchived, compiled);
  }
  let count = 0;
  for (const row of iterateSqliteQuerySync(database.db, { compile: () => compiled })) {
    count +=
      row.entry_json === null
        ? row.count
        : parseSessionEntryJson({ entry_json: row.entry_json })
          ? 1
          : 0;
  }
  return count;
}

export function* iterateSessionEntryKeys(
  database: OpenClawAgentDatabaseReader,
): IterableIterator<string> {
  const db = getSessionKysely(database.db);
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select([sessionEntryInventoryJson, "session_key"])
      .orderBy("session_key", "asc"),
  )) {
    if (row.entry_json === null || parseSessionEntryJson({ entry_json: row.entry_json })) {
      yield row.session_key;
    }
  }
}
