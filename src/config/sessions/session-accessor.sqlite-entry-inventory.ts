import type { CompiledQuery } from "kysely";
import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
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
  database: Pick<OpenClawAgentDatabase, "db">,
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
    const totalCount = db
      .selectFrom("session_nodes")
      .select((eb) => eb.fn.countAll<number>().as("count"));
    // Count compact indexes, then subtract unreadable rows in the same statement snapshot.
    compiled = db
      .selectNoFrom((eb) => [
        (includeArchived
          ? totalCount
          : eb(totalCount, "-", totalCount.where("archived_at", "is not", null))
        ).as("count"),
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
  // Eager execution reuses the shared statement cache without retaining a reader.
  for (const row of executeSqliteQuerySync(database.db, { compile: () => compiled }).rows) {
    count +=
      row.entry_json === null
        ? row.count
        : parseSessionEntryJson({ entry_json: row.entry_json })
          ? 0
          : -1;
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
