// Downgrade rescue for 2026.6.5 beta builds that moved session metadata to SQLite.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionEntry } from "./types.js";

const SESSION_STORE_SCOPE = "session_entries";

type RescueResult = {
  entries: number;
  sqlitePath: string;
};

type BetaSessionSqliteDatabase = {
  cache_entries: {
    scope: string;
    key: string;
    value_json: string | null;
    blob: Uint8Array | null;
    expires_at: number | null;
    updated_at: number;
  };
};

function resolveStructuralSessionStoreOwner(storePath: string):
  | {
      agentId: string;
      stateDir: string;
    }
  | undefined {
  const candidate = path.resolve(storePath);
  if (path.basename(candidate) !== "sessions.json") {
    return undefined;
  }
  const sessionsDir = path.dirname(candidate);
  if (path.basename(sessionsDir) !== "sessions") {
    return undefined;
  }
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    return undefined;
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir) || DEFAULT_AGENT_ID),
    stateDir: path.dirname(agentsDir),
  };
}

function resolveBetaSqliteSessionStorePath(storePath: string): string {
  const structural = resolveStructuralSessionStoreOwner(storePath);
  if (structural) {
    return resolveOpenClawAgentSqlitePath({
      agentId: structural.agentId,
      env: { ...process.env, OPENCLAW_STATE_DIR: structural.stateDir },
    });
  }
  const resolvedStorePath = path.resolve(storePath);
  const storeHash = crypto.createHash("sha256").update(resolvedStorePath).digest("hex");
  return path.join(
    path.dirname(resolvedStorePath),
    `openclaw-session-store-${storeHash.slice(0, 16)}.sqlite`,
  );
}

function sessionStoreJsonNeedsRescue(storePath: string): boolean {
  try {
    const stat = fs.statSync(storePath);
    if (!stat.isFile()) {
      return false;
    }
    if (stat.size === 0) {
      return true;
    }
    if (stat.size > 16) {
      return false;
    }
    const raw = fs.readFileSync(storePath, "utf8").trim();
    return raw === "{}";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function readBetaSqliteSessionEntries(sqlitePath: string): Record<string, SessionEntry> {
  if (!fs.existsSync(sqlitePath)) {
    return {};
  }
  const sqlite = requireNodeSqlite();
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    const db = getNodeSqliteKysely<BetaSessionSqliteDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("cache_entries")
        .select(["key", "value_json"])
        .where("scope", "=", SESSION_STORE_SCOPE)
        .orderBy("key", "asc"),
    ).rows;
    const store: Record<string, SessionEntry> = {};
    for (const row of rows) {
      if (typeof row.key !== "string" || typeof row.value_json !== "string") {
        continue;
      }
      try {
        const parsed = JSON.parse(row.value_json) as unknown;
        if (isRecord(parsed)) {
          store[row.key] = parsed as SessionEntry;
        }
      } catch {
        // A bad beta row should not block recovery of the rest of the store.
      }
    }
    return store;
  } finally {
    database?.close();
  }
}

function writeRecoveredSessionStore(storePath: string, store: Record<string, SessionEntry>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    path.dirname(storePath),
    `${path.basename(storePath)}.${process.pid}.${crypto.randomUUID()}.downgrade-rescue.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, storePath);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Best effort only; existing platform permissions may not support chmod.
  }
}

export function recoverBetaSqliteSessionStoreIfNeeded(storePath: string): RescueResult | null {
  if (!sessionStoreJsonNeedsRescue(storePath)) {
    return null;
  }
  const sqlitePath = resolveBetaSqliteSessionStorePath(storePath);
  try {
    const store = readBetaSqliteSessionEntries(sqlitePath);
    const entries = Object.keys(store).length;
    if (entries === 0) {
      return null;
    }
    writeRecoveredSessionStore(storePath, store);
    return { entries, sqlitePath };
  } catch {
    // Downgrade rescue is best-effort; normal JSON startup should continue.
    return null;
  }
}
