import fs, { readFileSync } from "node:fs";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  type OpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { resolveAgentIdFromSessionStorePath } from "./paths.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionStore } from "./store-normalize.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionStoreOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
  sourcePath?: string;
  now?: () => number;
};

export type SessionStoreBackendImportResult = {
  imported: number;
  sourcePath: string;
  removedSource: boolean;
};

type SessionEntryRow = {
  session_key: string;
  entry_json: string;
};

export function isSqliteSessionStoreBackendEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  return true;
}

export function resolveSqliteSessionStoreOptionsForPath(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): SqliteSessionStoreOptions | null {
  if (!isSqliteSessionStoreBackendEnabled(env)) {
    return null;
  }
  const agentId = resolveAgentIdFromSessionStorePath(storePath);
  if (!agentId) {
    return null;
  }
  return { agentId, env, sourcePath: storePath };
}

function resolveNow(options: SqliteSessionStoreOptions): number {
  return options.now?.() ?? Date.now();
}

function parseSessionEntry(row: SessionEntryRow): SessionEntry | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SessionEntry;
  } catch {
    return null;
  }
}

function bindSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
  updatedAt: number;
}): Record<string, SQLInputValue> {
  return {
    agent_id: params.agentId,
    session_key: params.sessionKey,
    entry_json: JSON.stringify(params.entry),
    updated_at: params.entry.updatedAt ?? params.updatedAt,
  };
}

function prepareReplaceStatement(statement: StatementSync, params: Record<string, SQLInputValue>) {
  statement.run(params);
}

function countSqliteSessionEntries(
  database: OpenClawStateDatabase,
  options: SqliteSessionStoreOptions,
): number {
  const row = database.db
    .prepare("SELECT COUNT(*) AS count FROM session_entries WHERE agent_id = ?")
    .get(options.agentId) as { count?: number | bigint } | undefined;
  const count = row?.count ?? 0;
  return typeof count === "bigint" ? Number(count) : count;
}

export function countSqliteSessionStoreEntries(options: SqliteSessionStoreOptions): number {
  const database = openOpenClawStateDatabase(options);
  return countSqliteSessionEntries(database, options);
}

function parseJsonSessionStoreFromPath(sourcePath: string): Record<string, SessionEntry> {
  let store: Record<string, SessionEntry> = {};
  try {
    const parsed = JSON.parse(readJsonSessionStoreRawForImport(sourcePath)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      store = parsed as Record<string, SessionEntry>;
    }
  } catch {
    store = {};
  }
  applySessionStoreMigrations(store);
  normalizeSessionStore(store);
  return store;
}

function replaceSqliteSessionStore(params: {
  database: OpenClawStateDatabase;
  options: SqliteSessionStoreOptions;
  store: Record<string, SessionEntry>;
}): void {
  const updatedAt = resolveNow(params.options);
  params.database.db
    .prepare("DELETE FROM session_entries WHERE agent_id = ?")
    .run(params.options.agentId);
  const insert = params.database.db.prepare(`
    INSERT INTO session_entries (
      agent_id,
      session_key,
      entry_json,
      updated_at
    ) VALUES (
      @agent_id,
      @session_key,
      @entry_json,
      @updated_at
    )
  `);
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    prepareReplaceStatement(
      insert,
      bindSessionEntry({
        agentId: params.options.agentId,
        sessionKey,
        entry,
        updatedAt,
      }),
    );
  }
}

export function loadSqliteSessionStore(
  options: SqliteSessionStoreOptions,
): Record<string, SessionEntry> {
  const database = openOpenClawStateDatabase(options);
  const rows = database.db
    .prepare(
      `
        SELECT session_key, entry_json
        FROM session_entries
        WHERE agent_id = ?
        ORDER BY session_key ASC
      `,
    )
    .all(options.agentId) as SessionEntryRow[];
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

export function saveSqliteSessionStore(
  options: SqliteSessionStoreOptions,
  store: Record<string, SessionEntry>,
): void {
  normalizeSessionStore(store);
  runOpenClawStateWriteTransaction((database) => {
    replaceSqliteSessionStore({ database, options, store });
  }, options);
}

export function mergeSqliteSessionStore(
  options: SqliteSessionStoreOptions,
  incoming: Record<string, SessionEntry>,
): { imported: number; stored: number } {
  const mergedStore = mergeSessionStoresByUpdatedAt(loadSqliteSessionStore(options), incoming);
  saveSqliteSessionStore(options, mergedStore);
  return {
    imported: Object.keys(incoming).length,
    stored: Object.keys(mergedStore).length,
  };
}

function resolveSessionEntryUpdatedAt(entry: SessionEntry): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

function mergeSessionStoresByUpdatedAt(
  existing: Record<string, SessionEntry>,
  incoming: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  const merged: Record<string, SessionEntry> = { ...existing };
  for (const [key, entry] of Object.entries(incoming)) {
    const current = merged[key];
    if (!current || resolveSessionEntryUpdatedAt(entry) >= resolveSessionEntryUpdatedAt(current)) {
      merged[key] = entry;
    }
  }
  normalizeSessionStore(merged);
  return merged;
}

export function importJsonSessionStoreToSqlite(params: {
  agentId: string;
  sourcePath: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): SessionStoreBackendImportResult {
  const options = {
    agentId: params.agentId,
    sourcePath: params.sourcePath,
    ...(params.env ? { env: params.env } : {}),
    ...(params.dbPath ? { path: params.dbPath } : {}),
    ...(params.now ? { now: params.now } : {}),
  };
  const importedStore = parseJsonSessionStoreFromPath(params.sourcePath);
  const result = mergeSqliteSessionStore(options, importedStore);
  let removedSource = false;
  try {
    fs.rmSync(params.sourcePath, { force: true });
    removedSource = true;
  } catch {
    removedSource = false;
  }
  return {
    imported: result.imported,
    sourcePath: params.sourcePath,
    removedSource,
  };
}

export function readJsonSessionStoreRawForImport(pathname: string): string {
  return readFileSync(pathname, "utf8");
}
