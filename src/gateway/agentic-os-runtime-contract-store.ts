import { mkdirSync } from "node:fs";
import path from "node:path";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";

const SNAPSHOT_KEY = "agentic-os-runtime-contract-v1";

export type AgenticOsRuntimeSnapshot = {
  leases: unknown[];
  releaseReplays: unknown[];
  sessions: unknown[];
};

function resolveRuntimeStorePath(): string {
  return path.join(resolveOpenClawStateSqliteDir(process.env), "agentic-os-runtime-contract.sqlite");
}

function openRuntimeStore() {
  const storePath = resolveRuntimeStorePath();
  mkdirSync(path.dirname(storePath), { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(storePath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runtime_snapshots (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
  `);
  return { db, storePath };
}

export function runtimeSnapshotPath(): string {
  return resolveRuntimeStorePath();
}

export function loadAgenticOsRuntimeSnapshot(): AgenticOsRuntimeSnapshot | undefined {
  const { db } = openRuntimeStore();
  try {
    const row = db
      .prepare("SELECT payload_json FROM runtime_snapshots WHERE key = ?")
      .get(SNAPSHOT_KEY) as { payload_json?: unknown } | undefined;
    return typeof row?.payload_json === "string"
      ? (JSON.parse(row.payload_json) as AgenticOsRuntimeSnapshot)
      : undefined;
  } finally {
    db.close();
  }
}

export function saveAgenticOsRuntimeSnapshot(snapshot: AgenticOsRuntimeSnapshot): void {
  const { db } = openRuntimeStore();
  try {
    db.prepare(
      `
        INSERT INTO runtime_snapshots (key, payload_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at_ms = excluded.updated_at_ms
      `,
    ).run(SNAPSHOT_KEY, JSON.stringify(snapshot), Date.now());
  } finally {
    db.close();
  }
}

export function resetAgenticOsRuntimeStoreForTest(): void {
  const { db } = openRuntimeStore();
  try {
    db.prepare("DELETE FROM runtime_snapshots WHERE key = ?").run(SNAPSHOT_KEY);
  } finally {
    db.close();
  }
}
