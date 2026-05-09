import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabaseOptions,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { TuiSessionList } from "./tui-backend.js";
import type { SessionScope } from "./tui-types.js";

type LastSessionRecord = {
  sessionKey: string;
  updatedAt: number;
};

type TuiLastSessionsTable = OpenClawStateKyselyDatabase["tui_last_sessions"];
type TuiLastSessionRow = Selectable<TuiLastSessionsTable>;
type TuiLastSessionDatabase = Pick<OpenClawStateKyselyDatabase, "tui_last_sessions">;

export function buildTuiLastSessionScopeKey(params: {
  connectionUrl: string;
  agentId: string;
  sessionScope: SessionScope;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const connectionUrl = params.connectionUrl.trim() || "local";
  return createHash("sha256")
    .update(`${params.sessionScope}\n${agentId}\n${connectionUrl}`)
    .digest("hex")
    .slice(0, 32);
}

function sqliteOptionsForStateDir(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {};
}

function normalizeLastSessionRecord(value: unknown): LastSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : null;
  if (!sessionKey || updatedAt === null || !Number.isFinite(updatedAt)) {
    return null;
  }
  return { sessionKey, updatedAt };
}

function getTuiLastSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TuiLastSessionDatabase>(db);
}

function recordToRow(params: {
  scopeKey: string;
  record: LastSessionRecord;
}): Insertable<TuiLastSessionsTable> {
  return {
    scope_key: params.scopeKey,
    session_key: params.record.sessionKey,
    updated_at: params.record.updatedAt,
  };
}

function rowToRecord(row: TuiLastSessionRow | undefined): LastSessionRecord | null {
  if (!row) {
    return null;
  }
  return normalizeLastSessionRecord({
    sessionKey: row.session_key,
    updatedAt: row.updated_at,
  });
}

function writeTuiLastSessionRow(params: {
  scopeKey: string;
  record: LastSessionRecord;
  stateDir?: string;
}): void {
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getTuiLastSessionKysely(stateDatabase.db);
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .insertInto("tui_last_sessions")
        .values(recordToRow(params))
        .onConflict((conflict) =>
          conflict.column("scope_key").doUpdateSet({
            session_key: (eb) => eb.ref("excluded.session_key"),
            updated_at: (eb) => eb.ref("excluded.updated_at"),
          }),
        ),
    );
  }, sqliteOptionsForStateDir(params.stateDir));
}

function normalizeMarker(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isHeartbeatSessionKey(sessionKey: string): boolean {
  return normalizeMarker(sessionKey).endsWith(":heartbeat");
}

export function isHeartbeatLikeTuiSession(session: TuiSessionList["sessions"][number]): boolean {
  if (isHeartbeatSessionKey(session.key)) {
    return true;
  }
  const markers = [
    session.provider,
    session.lastProvider,
    session.lastChannel,
    session.lastTo,
    session.origin?.provider,
    session.origin?.surface,
    session.origin?.label,
  ];
  return markers.some((marker) => normalizeMarker(marker) === "heartbeat");
}

export async function readTuiLastSessionKey(params: {
  scopeKey: string;
  stateDir?: string;
}): Promise<string | null> {
  const stateDatabase = openOpenClawStateDatabase(sqliteOptionsForStateDir(params.stateDir));
  const db = getTuiLastSessionKysely(stateDatabase.db);
  const row = executeSqliteQuerySync(
    stateDatabase.db,
    db.selectFrom("tui_last_sessions").selectAll().where("scope_key", "=", params.scopeKey),
  ).rows[0];
  return rowToRecord(row)?.sessionKey ?? null;
}

export async function writeTuiLastSessionKey(params: {
  scopeKey: string;
  sessionKey: string;
  stateDir?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || sessionKey === "unknown" || isHeartbeatSessionKey(sessionKey)) {
    return;
  }
  const record = {
    sessionKey,
    updatedAt: Date.now(),
  };
  writeTuiLastSessionRow({
    scopeKey: params.scopeKey,
    record,
    stateDir: params.stateDir,
  });
}

export async function clearTuiLastSessionPointers(params: {
  stateDir?: string;
  sessionKeys: ReadonlySet<string>;
}): Promise<number> {
  if (params.sessionKeys.size === 0) {
    return 0;
  }
  let removed = 0;
  const sessionKeys = [...params.sessionKeys];
  runOpenClawStateWriteTransaction((stateDatabase) => {
    const db = getTuiLastSessionKysely(stateDatabase.db);
    const result = executeSqliteQuerySync(
      stateDatabase.db,
      db.deleteFrom("tui_last_sessions").where("session_key", "in", sessionKeys),
    );
    removed = Number(result.numAffectedRows ?? 0n);
  }, sqliteOptionsForStateDir(params.stateDir));
  return removed;
}

export function resolveRememberedTuiSessionKey(params: {
  rememberedKey: string | null | undefined;
  currentAgentId: string;
  sessions: TuiSessionList["sessions"];
}): string | null {
  const rememberedKey = params.rememberedKey?.trim();
  if (!rememberedKey) {
    return null;
  }
  if (isHeartbeatSessionKey(rememberedKey)) {
    return null;
  }
  const currentAgentId = normalizeAgentId(params.currentAgentId);
  const parsed = parseAgentSessionKey(rememberedKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== currentAgentId) {
    return null;
  }
  const rememberedRest = parsed?.rest ?? rememberedKey;
  const match = params.sessions.find((session) => {
    if (isHeartbeatLikeTuiSession(session)) {
      return false;
    }
    if (session.key === rememberedKey) {
      return true;
    }
    return parseAgentSessionKey(session.key)?.rest === rememberedRest;
  });
  return match?.key ?? null;
}
