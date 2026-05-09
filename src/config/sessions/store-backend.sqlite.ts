import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  type OpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { type OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { normalizeSessionStore } from "./store-normalize.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionEntriesOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  now?: () => number;
};

export type ReplaceSqliteSessionEntryOptions = SqliteSessionEntriesOptions & {
  sessionKey: string;
  entry: SessionEntry;
};

export type ApplySqliteSessionEntriesPatchOptions = SqliteSessionEntriesOptions & {
  upsertEntries?: Readonly<Record<string, SessionEntry>>;
  expectedEntries?: ReadonlyMap<string, SessionEntry | null>;
};

type SessionEntriesTable = OpenClawAgentKyselyDatabase["session_entries"];
type SessionEntriesDatabase = Pick<OpenClawAgentKyselyDatabase, "session_entries">;

type SessionEntryRow = Pick<Selectable<SessionEntriesTable>, "entry_json" | "session_key"> &
  Partial<Pick<Selectable<SessionEntriesTable>, "updated_at">>;

function resolveNow(options: SqliteSessionEntriesOptions): number {
  return options.now?.() ?? Date.now();
}

function parseSessionEntry(row: SessionEntryRow): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const store = { [row.session_key]: parsed as SessionEntry };
    normalizeSessionStore(store);
    return stripDerivedTranscriptLocator(store[row.session_key] ?? null);
  } catch {
    return null;
  }
}

function stripDerivedTranscriptLocator(entry: SessionEntry | null): SessionEntry | null {
  if (!entry) {
    return null;
  }
  const { transcriptLocator: _derivedTranscriptLocator, ...rest } = entry;
  return rest;
}

function serializeSessionEntry(sessionKey: string, entry: SessionEntry): string {
  const store = { [sessionKey]: entry };
  normalizeSessionStore(store);
  return JSON.stringify(stripDerivedTranscriptLocator(store[sessionKey] ?? entry) ?? entry);
}

function bindSessionEntry(params: {
  sessionKey: string;
  entry: SessionEntry;
  updatedAt: number;
}): Insertable<SessionEntriesTable> {
  return {
    session_key: params.sessionKey,
    entry_json: serializeSessionEntry(params.sessionKey, params.entry),
    updated_at: params.entry.updatedAt ?? params.updatedAt,
  };
}

function serializeExpectedSessionEntry(sessionKey: string, entry: SessionEntry): string {
  return serializeSessionEntry(sessionKey, entry);
}

function upsertSessionEntries(
  database: OpenClawAgentDatabase,
  rows: ReadonlyArray<Insertable<SessionEntriesTable>>,
): void {
  if (rows.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values(rows)
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          entry_json: (eb) => eb.ref("excluded.entry_json"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      ),
  );
}

function countSessionEntryRows(database: OpenClawAgentDatabase): number {
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select((eb) => eb.fn.countAll<number | bigint>().as("count")),
  );
  const count = row?.count ?? 0;
  return typeof count === "bigint" ? Number(count) : count;
}

function readSqliteSessionEntryJson(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): string | null {
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select(["entry_json"]).where("session_key", "=", sessionKey),
  );
  return row?.entry_json ?? null;
}

function normalizeStoredSessionEntryJson(
  sessionKey: string,
  entryJson: string | null,
): string | null {
  if (entryJson === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(entryJson) as SessionEntry;
    return serializeExpectedSessionEntry(sessionKey, parsed);
  } catch {
    return entryJson;
  }
}

export function countSqliteSessionEntries(options: SqliteSessionEntriesOptions): number {
  const database = openOpenClawAgentDatabase(options);
  return countSessionEntryRows(database);
}

export function replaceSqliteSessionEntry(options: ReplaceSqliteSessionEntryOptions): void {
  const store = { [options.sessionKey]: options.entry };
  normalizeSessionStore(store);
  const entry = store[options.sessionKey] ?? options.entry;
  const updatedAt = resolveNow(options);
  runOpenClawAgentWriteTransaction((database) => {
    upsertSessionEntries(database, [
      bindSessionEntry({
        sessionKey: options.sessionKey,
        entry,
        updatedAt,
      }),
    ]);
  }, options);
}

export function applySqliteSessionEntriesPatch(
  options: ApplySqliteSessionEntriesPatchOptions,
): boolean {
  const upsertEntries = { ...options.upsertEntries };
  normalizeSessionStore(upsertEntries);
  const updatedAt = resolveNow(options);
  return runOpenClawAgentWriteTransaction((database) => {
    for (const [sessionKey, expected] of options.expectedEntries?.entries() ?? []) {
      const currentJson = normalizeStoredSessionEntryJson(
        sessionKey,
        readSqliteSessionEntryJson(database, sessionKey),
      );
      const expectedJson = expected ? serializeExpectedSessionEntry(sessionKey, expected) : null;
      if (currentJson !== expectedJson) {
        return false;
      }
    }
    upsertSessionEntries(
      database,
      Object.entries(upsertEntries).map(([sessionKey, entry]) =>
        bindSessionEntry({
          sessionKey,
          entry,
          updatedAt,
        }),
      ),
    );
    return true;
  }, options);
}

export function readSqliteSessionEntry(
  options: SqliteSessionEntriesOptions & { sessionKey: string },
): SessionEntry | undefined {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json"])
      .where("session_key", "=", options.sessionKey),
  );
  return row ? (parseSessionEntry(row) ?? undefined) : undefined;
}

export function deleteSqliteSessionEntry(
  options: SqliteSessionEntriesOptions & { sessionKey: string },
): boolean {
  return runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_entries").where("session_key", "=", options.sessionKey),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, options);
}

export function listSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
): Array<{ sessionKey: string; entry: SessionEntry }> {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json"])
      .orderBy("updated_at", "desc")
      .orderBy("session_key", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const entry = parseSessionEntry(row);
    return entry ? [{ sessionKey: row.session_key, entry }] : [];
  });
}

export function loadSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
): Record<string, SessionEntry> {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select(["session_key", "entry_json"])
      .orderBy("session_key", "asc"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntry(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  normalizeSessionStore(store);
  return store;
}

export function mergeSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
  incoming: Record<string, SessionEntry>,
): { imported: number; stored: number } {
  normalizeSessionStore(incoming);
  const existing = loadSqliteSessionEntries(options);
  const upsertEntries: Record<string, SessionEntry> = {};
  for (const [key, entry] of Object.entries(incoming)) {
    const current = existing[key];
    if (!current || resolveSessionEntryUpdatedAt(entry) >= resolveSessionEntryUpdatedAt(current)) {
      upsertEntries[key] = entry;
      existing[key] = entry;
    }
  }
  applySqliteSessionEntriesPatch({
    ...options,
    upsertEntries,
  });
  return {
    imported: Object.keys(incoming).length,
    stored: Object.keys(existing).length,
  };
}

function resolveSessionEntryUpdatedAt(entry: SessionEntry): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}
