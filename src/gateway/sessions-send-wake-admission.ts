import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";

export const SESSIONS_SEND_WAKE_ADMISSION_LIMIT = 6;
export const SESSIONS_SEND_WAKE_ADMISSION_WINDOW_MS = 15 * 60_000;

export type SessionsSendWakeAdmissionConfig = {
  enabled?: boolean;
  limit?: number;
  windowMs?: number;
};

export type SessionsSendWakeAdmissionRequest = {
  idempotencyKey: string;
  sourceSessionKey?: string;
  targetSessionKey?: string;
  targetAgentId?: string;
};

export type SessionsSendWakeAdmissionDecision =
  | { allowed: true; replayed: boolean }
  | { allowed: false; replayed: boolean; reason: "limit_exhausted" | "state_unavailable" };

function resolveAdmissionDatabasePath(): string {
  return path.join(resolveOpenClawStateSqliteDir(), "sessions-send-wake-admission.sqlite");
}

/**
 * Persisted, per-recipient admission for wake-starting sessions_send requests.
 * This intentionally owns a small separate database: it must remain usable even
 * when a session store is being repaired, and it must never become session data.
 */
export function admitSessionsSendWake(params: {
  config?: SessionsSendWakeAdmissionConfig;
  request: SessionsSendWakeAdmissionRequest;
  databasePath?: string;
  nowMs?: number;
}): SessionsSendWakeAdmissionDecision {
  const config = params.config;
  if (config?.enabled !== true) {
    return { allowed: true, replayed: false };
  }
  const nowMs = params.nowMs ?? Date.now();
  const limit = config.limit ?? SESSIONS_SEND_WAKE_ADMISSION_LIMIT;
  const windowMs = config.windowMs ?? SESSIONS_SEND_WAKE_ADMISSION_WINDOW_MS;
  const databasePath = params.databasePath ?? resolveAdmissionDatabasePath();
  let db: DatabaseSync | undefined;
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS sessions_send_wake_admissions (
      idempotency_key TEXT PRIMARY KEY,
      source_session_key TEXT,
      target_session_key TEXT,
      target_agent_id TEXT,
      decision TEXT NOT NULL CHECK (decision IN ('admitted', 'rejected')),
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      gateway_instance TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_send_wake_admissions_window
      ON sessions_send_wake_admissions (decision, expires_at_ms);`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare(
          "SELECT decision, reason FROM sessions_send_wake_admissions WHERE idempotency_key = ?",
        )
        .get(params.request.idempotencyKey) as
        | { decision: "admitted" | "rejected"; reason: string }
        | undefined;
      if (existing) {
        db.exec("COMMIT");
        return existing.decision === "admitted"
          ? { allowed: true, replayed: true }
          : { allowed: false, replayed: true, reason: "limit_exhausted" };
      }
      db.prepare("DELETE FROM sessions_send_wake_admissions WHERE expires_at_ms <= ?").run(nowMs);
      const active = db
        .prepare(
          "SELECT COUNT(*) AS count FROM sessions_send_wake_admissions WHERE decision = 'admitted' AND expires_at_ms > ?",
        )
        .get(nowMs) as { count: number };
      const allowed = active.count < limit;
      db.prepare(`INSERT INTO sessions_send_wake_admissions
        (idempotency_key, source_session_key, target_session_key, target_agent_id, decision, reason, created_at_ms, expires_at_ms, gateway_instance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        params.request.idempotencyKey,
        params.request.sourceSessionKey ?? null,
        params.request.targetSessionKey ?? null,
        params.request.targetAgentId ?? null,
        allowed ? "admitted" : "rejected",
        allowed ? "admitted" : "limit_exhausted",
        nowMs,
        nowMs + windowMs,
        `${process.pid}`,
      );
      db.exec("COMMIT");
      return allowed
        ? { allowed: true, replayed: false }
        : { allowed: false, replayed: false, reason: "limit_exhausted" };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* original failure wins */
      }
      throw error;
    }
  } catch {
    // This is an automated wake admission boundary. A missing, locked, or corrupt
    // receipt store must never permit work based on an in-memory fallback.
    return { allowed: false, replayed: false, reason: "state_unavailable" };
  } finally {
    db?.close();
  }
}
