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
import { normalizeSessionEntries } from "./session-entry-normalize.js";
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
type SessionsTable = OpenClawAgentKyselyDatabase["sessions"];
type SessionEntriesDatabase = Pick<OpenClawAgentKyselyDatabase, "session_entries" | "sessions">;

type SessionEntryRow = Pick<Selectable<SessionEntriesTable>, "entry_json" | "session_key"> &
  Partial<Pick<Selectable<SessionEntriesTable>, "updated_at">>;
type BoundSessionEntryRow = {
  entry: Insertable<SessionEntriesTable>;
  session: Insertable<SessionsTable>;
};

function resolveNow(options: SqliteSessionEntriesOptions): number {
  return options.now?.() ?? Date.now();
}

function parseSessionEntry(row: SessionEntryRow): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const entries = { [row.session_key]: parsed as SessionEntry };
    normalizeSessionEntries(entries);
    return entries[row.session_key] ?? null;
  } catch {
    return null;
  }
}

function serializeSessionEntry(sessionKey: string, entry: SessionEntry): string {
  const entries = { [sessionKey]: entry };
  normalizeSessionEntries(entries);
  return JSON.stringify(entries[sessionKey] ?? entry);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionDisplayName(entry: SessionEntry): string | null {
  return nullableString(entry.displayName) ?? nullableString(entry.label);
}

function resolveSessionCreatedAt(entry: SessionEntry, updatedAt: number): number {
  for (const candidate of [entry.sessionStartedAt, entry.startedAt, entry.updatedAt, updatedAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return updatedAt;
}

function bindSessionRoot(params: {
  sessionKey: string;
  entry: SessionEntry;
  updatedAt: number;
}): Insertable<SessionsTable> {
  const sessionId = nullableString(params.entry.sessionId) ?? params.sessionKey;
  const updatedAt =
    typeof params.entry.updatedAt === "number" && Number.isFinite(params.entry.updatedAt)
      ? params.entry.updatedAt
      : params.updatedAt;
  return {
    session_id: sessionId,
    session_key: params.sessionKey,
    created_at: resolveSessionCreatedAt(params.entry, updatedAt),
    updated_at: updatedAt,
    started_at:
      typeof params.entry.startedAt === "number" && Number.isFinite(params.entry.startedAt)
        ? params.entry.startedAt
        : null,
    ended_at:
      typeof params.entry.endedAt === "number" && Number.isFinite(params.entry.endedAt)
        ? params.entry.endedAt
        : null,
    status: nullableString(params.entry.status),
    chat_type: nullableString(params.entry.chatType),
    channel: nullableString(params.entry.channel) ?? nullableString(params.entry.lastChannel),
    model_provider: nullableString(params.entry.modelProvider),
    model: nullableString(params.entry.model),
    agent_harness_id: nullableString(params.entry.agentHarnessId),
    parent_session_key: nullableString(params.entry.parentSessionKey),
    spawned_by: nullableString(params.entry.spawnedBy),
    display_name: sessionDisplayName(params.entry),
  };
}

function bindSessionEntry(params: {
  sessionKey: string;
  entry: SessionEntry;
  updatedAt: number;
}): BoundSessionEntryRow {
  const session = bindSessionRoot(params);
  return {
    session,
    entry: {
      session_key: params.sessionKey,
      session_id: session.session_id,
      entry_json: serializeSessionEntry(params.sessionKey, params.entry),
      updated_at: session.updated_at,
    },
  };
}

function serializeExpectedSessionEntry(sessionKey: string, entry: SessionEntry): string {
  return serializeSessionEntry(sessionKey, entry);
}

function upsertSessionEntries(
  database: OpenClawAgentDatabase,
  rows: ReadonlyArray<BoundSessionEntryRow>,
): void {
  if (rows.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionEntriesDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("sessions")
      .values(rows.map((row) => row.session))
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          session_key: (eb) => eb.ref("excluded.session_key"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          started_at: (eb) => eb.ref("excluded.started_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
          status: (eb) => eb.ref("excluded.status"),
          chat_type: (eb) => eb.ref("excluded.chat_type"),
          channel: (eb) => eb.ref("excluded.channel"),
          model_provider: (eb) => eb.ref("excluded.model_provider"),
          model: (eb) => eb.ref("excluded.model"),
          agent_harness_id: (eb) => eb.ref("excluded.agent_harness_id"),
          parent_session_key: (eb) => eb.ref("excluded.parent_session_key"),
          spawned_by: (eb) => eb.ref("excluded.spawned_by"),
          display_name: (eb) => eb.ref("excluded.display_name"),
        }),
      ),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_entries")
      .values(rows.map((row) => row.entry))
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: (eb) => eb.ref("excluded.session_id"),
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
  const entries = { [options.sessionKey]: options.entry };
  normalizeSessionEntries(entries);
  const entry = entries[options.sessionKey] ?? options.entry;
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
  normalizeSessionEntries(upsertEntries);
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
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_entries")
        .select("session_id")
        .where("session_key", "=", options.sessionKey),
    );
    if (!row) {
      return false;
    }
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("sessions").where("session_id", "=", row.session_id),
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
  const entries: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntry(row);
    if (entry) {
      entries[row.session_key] = entry;
    }
  }
  normalizeSessionEntries(entries);
  return entries;
}

export function mergeSqliteSessionEntries(
  options: SqliteSessionEntriesOptions,
  incoming: Record<string, SessionEntry>,
): { imported: number; stored: number } {
  normalizeSessionEntries(incoming);
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
