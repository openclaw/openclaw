import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

const OPENCLAW_AGENT_SCHEMA_VERSION = 4;
const OPENCLAW_AGENT_DB_DIR_MODE = 0o700;
const OPENCLAW_AGENT_DB_FILE_MODE = 0o600;
const OPENCLAW_AGENT_DB_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

export type OpenClawAgentDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

type UserVersionRow = {
  user_version?: number | bigint;
};

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

const cachedDatabases = new Map<string, OpenClawAgentDatabase>();

type TranscriptEventIdentityBackfillRow = {
  session_id?: unknown;
  seq?: unknown;
  event_json?: unknown;
  created_at?: unknown;
};

export type OpenClawRegisteredAgentDatabase = {
  agentId: string;
  path: string;
  schemaVersion: number;
  lastSeenAt: number;
  sizeBytes: number | null;
};

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  const raw = row?.user_version ?? 0;
  return typeof raw === "bigint" ? Number(raw) : raw;
}

export function resolveOpenClawAgentSqlitePath(options: OpenClawAgentDatabaseOptions): string {
  const agentId = normalizeAgentId(options.agentId);
  return (
    options.path ??
    path.join(
      resolveStateDir(options.env ?? process.env),
      "agents",
      agentId,
      "agent",
      "openclaw-agent.sqlite",
    )
  );
}

function ensureOpenClawAgentDatabasePermissions(pathname: string): void {
  mkdirSync(path.dirname(pathname), { recursive: true, mode: OPENCLAW_AGENT_DB_DIR_MODE });
  chmodSync(path.dirname(pathname), OPENCLAW_AGENT_DB_DIR_MODE);
  for (const suffix of OPENCLAW_AGENT_DB_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, OPENCLAW_AGENT_DB_FILE_MODE);
    }
  }
}

function migrateAgentSchema(db: DatabaseSync, fromVersion: number): void {
  if (fromVersion < 4) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_transcript_events_updated
        ON transcript_events(session_id, created_at DESC, seq DESC);
      CREATE TABLE IF NOT EXISTS transcript_event_identities (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT,
        has_parent INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        message_idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, event_id),
        FOREIGN KEY (session_id, seq) REFERENCES transcript_events(session_id, seq) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transcript_message_idempotency
        ON transcript_event_identities(session_id, message_idempotency_key)
        WHERE message_idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agent_transcript_tail
        ON transcript_event_identities(session_id, seq DESC)
        WHERE has_parent = 1;
    `);
    backfillTranscriptEventIdentities(db);
  }
}

function readTranscriptEventIdentity(eventJson: unknown): {
  eventId: string;
  eventType: string | null;
  hasParent: 0 | 1;
  parentId: string | null;
  messageIdempotencyKey: string | null;
} | null {
  if (typeof eventJson !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as {
    id?: unknown;
    type?: unknown;
    parentId?: unknown;
    message?: { idempotencyKey?: unknown };
  };
  if (typeof record.id !== "string" || !record.id.trim()) {
    return null;
  }
  const idempotencyKey =
    typeof record.message?.idempotencyKey === "string" && record.message.idempotencyKey.trim()
      ? record.message.idempotencyKey
      : null;
  return {
    eventId: record.id,
    eventType: typeof record.type === "string" ? record.type : null,
    hasParent: Object.hasOwn(record, "parentId") ? 1 : 0,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    messageIdempotencyKey: idempotencyKey,
  };
}

function backfillTranscriptEventIdentities(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT session_id, seq, event_json, created_at
       FROM transcript_events
       ORDER BY session_id ASC, seq ASC`,
    )
    .all() as TranscriptEventIdentityBackfillRow[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transcript_event_identities
       (session_id, event_id, seq, event_type, has_parent, parent_id, message_idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    if (typeof row.session_id !== "string") {
      continue;
    }
    const seq = typeof row.seq === "bigint" ? Number(row.seq) : Number(row.seq);
    const createdAt =
      typeof row.created_at === "bigint" ? Number(row.created_at) : Number(row.created_at);
    if (!Number.isInteger(seq) || !Number.isFinite(createdAt)) {
      continue;
    }
    const identity = readTranscriptEventIdentity(row.event_json);
    if (!identity) {
      continue;
    }
    insert.run(
      row.session_id,
      identity.eventId,
      seq,
      identity.eventType,
      identity.hasParent,
      identity.parentId,
      identity.messageIdempotencyKey,
      createdAt,
    );
  }
}

function ensureAgentSchema(db: DatabaseSync, pathname: string): void {
  const userVersion = getUserVersion(db);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database schema version ${userVersion} is newer than supported version ${OPENCLAW_AGENT_SCHEMA_VERSION}: ${pathname}`,
    );
  }

  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  migrateAgentSchema(db, userVersion);
  db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
}

function registerAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: params.path,
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.column("agent_id").doUpdateSet({
              path: params.path,
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
    },
    { env: params.env },
  );
}

export function listOpenClawRegisteredAgentDatabases(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawRegisteredAgentDatabase[] {
  const database = openOpenClawStateDatabase(options);
  const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
  const rows = executeSqliteQuerySync<OpenClawStateKyselyDatabase["agent_databases"]>(
    database.db,
    db.selectFrom("agent_databases").selectAll().orderBy("agent_id", "asc"),
  ).rows;
  return rows.map((row) => ({
    agentId: normalizeAgentId(row.agent_id),
    path: row.path,
    schemaVersion: row.schema_version,
    lastSeenAt: row.last_seen_at,
    sizeBytes: row.size_bytes,
  }));
}

export function openOpenClawAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
  const cached = cachedDatabases.get(pathname);
  if (cached) {
    registerAgentDatabase({ agentId, path: pathname, env: options.env });
    return cached;
  }

  ensureOpenClawAgentDatabasePermissions(pathname);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = configureSqliteWalMaintenance(db);
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA foreign_keys = ON;");
  ensureAgentSchema(db, pathname);
  ensureOpenClawAgentDatabasePermissions(pathname);
  const database = { agentId, db, path: pathname, walMaintenance };
  cachedDatabases.set(pathname, database);
  registerAgentDatabase({ agentId, path: pathname, env: options.env });
  return database;
}

export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
): T {
  const database = openOpenClawAgentDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database));
  ensureOpenClawAgentDatabasePermissions(database.path);
  return result;
}

export function closeOpenClawAgentDatabasesForTest(): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    database.db.close();
  }
  cachedDatabases.clear();
}
