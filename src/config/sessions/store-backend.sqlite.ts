import fs, { readFileSync } from "node:fs";
import path from "node:path";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import {
  type OpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { resolveAgentIdFromSessionStorePath, resolveStorePath } from "./paths.js";
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
};

type SessionEntryRow = {
  session_key: string;
  entry_json: string;
};

export type SqliteSessionStoreBackendMode = "auto" | "json" | "sqlite";

export function resolveSqliteSessionStoreBackendMode(
  env: NodeJS.ProcessEnv = process.env,
): SqliteSessionStoreBackendMode {
  const raw = env.OPENCLAW_SESSION_STORE_BACKEND?.trim().toLowerCase();
  if (raw === "json" || raw === "file" || raw === "files" || raw === "disabled") {
    return "json";
  }
  if (raw === "sqlite") {
    return "sqlite";
  }
  return "auto";
}

export function isSqliteSessionStoreBackendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSqliteSessionStoreBackendMode(env) !== "json";
}

function isCanonicalAgentSessionStorePath(params: {
  storePath: string;
  agentId: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    path.resolve(params.storePath) ===
    path.resolve(resolveStorePath(undefined, { agentId: params.agentId, env: params.env }))
  );
}

export function resolveSqliteSessionStoreOptionsForPath(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): SqliteSessionStoreOptions | null {
  const mode = resolveSqliteSessionStoreBackendMode(env);
  if (mode === "json") {
    return null;
  }
  const agentId = resolveAgentIdFromSessionStorePath(storePath);
  if (!agentId) {
    return null;
  }
  if (mode === "auto" && !isCanonicalAgentSessionStorePath({ storePath, agentId, env })) {
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

function resolveImportMarkerKey(options: SqliteSessionStoreOptions): string | null {
  const sourcePath = options.sourcePath?.trim();
  return sourcePath ? `${options.agentId}:${path.resolve(sourcePath)}` : null;
}

function readImportMarker(
  database: OpenClawStateDatabase,
  options: SqliteSessionStoreOptions,
): string | null {
  const markerKey = resolveImportMarkerKey(options);
  if (!markerKey) {
    return null;
  }
  const row = database.db
    .prepare("SELECT value_json FROM kv WHERE scope = ? AND key = ?")
    .get("session-store-import", markerKey) as { value_json?: unknown } | undefined;
  return typeof row?.value_json === "string" ? row.value_json : null;
}

function writeImportMarker(params: {
  database: OpenClawStateDatabase;
  options: SqliteSessionStoreOptions;
  imported: number;
  sourceExists: boolean;
}): void {
  const markerKey = resolveImportMarkerKey(params.options);
  if (!markerKey) {
    return;
  }
  params.database.db
    .prepare(
      `
        INSERT OR REPLACE INTO kv (
          scope,
          key,
          value_json,
          updated_at
        ) VALUES (
          @scope,
          @key,
          @value_json,
          @updated_at
        )
      `,
    )
    .run({
      scope: "session-store-import",
      key: markerKey,
      value_json: JSON.stringify({
        imported: params.imported,
        sourceExists: params.sourceExists,
        sourcePath: path.resolve(params.options.sourcePath ?? ""),
      }),
      updated_at: resolveNow(params.options),
    });
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

function importLegacyJsonSessionStoreIfNeeded(options: SqliteSessionStoreOptions): void {
  const sourcePath = options.sourcePath?.trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return;
  }
  runOpenClawStateWriteTransaction((database) => {
    if (readImportMarker(database, options)) {
      return;
    }
    const existingRows = countSqliteSessionEntries(database, options);
    if (existingRows > 0) {
      writeImportMarker({ database, options, imported: 0, sourceExists: true });
      return;
    }
    const store = parseJsonSessionStoreFromPath(sourcePath);
    replaceSqliteSessionStore({ database, options, store });
    writeImportMarker({
      database,
      options,
      imported: Object.keys(store).length,
      sourceExists: true,
    });
  }, options);
}

export function loadSqliteSessionStore(
  options: SqliteSessionStoreOptions,
): Record<string, SessionEntry> {
  importLegacyJsonSessionStoreIfNeeded(options);
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
    writeImportMarker({
      database,
      options,
      imported: Object.keys(store).length,
      sourceExists: Boolean(options.sourcePath && fs.existsSync(options.sourcePath)),
    });
  }, options);
}

export function importJsonSessionStoreToSqlite(params: {
  agentId: string;
  sourcePath: string;
  dbPath?: string;
  now?: () => number;
}): SessionStoreBackendImportResult {
  const store = parseJsonSessionStoreFromPath(params.sourcePath);
  saveSqliteSessionStore(
    {
      agentId: params.agentId,
      sourcePath: params.sourcePath,
      ...(params.dbPath ? { path: params.dbPath } : {}),
      ...(params.now ? { now: params.now } : {}),
    },
    store,
  );
  return { imported: Object.keys(store).length, sourcePath: params.sourcePath };
}

export function exportSqliteSessionStore(
  options: SqliteSessionStoreOptions,
): Record<string, SessionEntry> {
  return loadSqliteSessionStore(options);
}

export function readJsonSessionStoreRawForImport(pathname: string): string {
  return readFileSync(pathname, "utf8");
}
