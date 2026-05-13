import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import { resolveStateDir } from "../../../config/paths.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { privateFileStore } from "../../../infra/private-file-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";

type LastSessionRecord = {
  sessionKey: string;
  updatedAt: number;
};

type LastSessionStore = Record<string, LastSessionRecord>;
type TuiLastSessionsTable = OpenClawStateKyselyDatabase["tui_last_sessions"];
type TuiLastSessionDatabase = Pick<OpenClawStateKyselyDatabase, "tui_last_sessions">;

export function resolveLegacyTuiLastSessionStatePath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "tui", "last-session.json");
}

async function readStore(filePath: string): Promise<LastSessionStore> {
  try {
    const parsed = await privateFileStore(path.dirname(filePath)).readJsonIfExists(
      path.basename(filePath),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LastSessionStore)
      : {};
  } catch {
    return {};
  }
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

function isHeartbeatSessionKey(sessionKey: string): boolean {
  return sessionKey.trim().toLowerCase().endsWith(":heartbeat");
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

function writeTuiLastSessionRecordForDoctorImport(params: {
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

export async function legacyTuiLastSessionFileExists(
  params: {
    stateDir?: string;
  } = {},
): Promise<boolean> {
  try {
    await fs.access(resolveLegacyTuiLastSessionStatePath(params.stateDir));
    return true;
  } catch {
    return false;
  }
}

export async function importLegacyTuiLastSessionStoreToSqlite(
  params: {
    stateDir?: string;
  } = {},
): Promise<{ imported: boolean; pointers: number }> {
  const filePath = resolveLegacyTuiLastSessionStatePath(params.stateDir);
  if (!(await legacyTuiLastSessionFileExists(params))) {
    return { imported: false, pointers: 0 };
  }
  const store = await readStore(filePath);
  let pointers = 0;
  for (const [scopeKey, value] of Object.entries(store)) {
    const record = normalizeLastSessionRecord(value);
    if (!record || isHeartbeatSessionKey(record.sessionKey)) {
      continue;
    }
    writeTuiLastSessionRecordForDoctorImport({
      scopeKey,
      record,
      stateDir: params.stateDir,
    });
    pointers += 1;
  }
  await fs.rm(filePath, { force: true });
  return { imported: true, pointers };
}
