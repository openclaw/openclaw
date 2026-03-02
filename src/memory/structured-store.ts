import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { requireNodeSqlite } from "./sqlite.js";

/** Maximum size for a single JSON value (64 KB). */
const MAX_VALUE_BYTES = 64 * 1024;

/** Maximum entries per collection. */
const MAX_COLLECTION_ENTRIES = 10_000;

export interface StructuredEntry {
  collection: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface StructuredStore {
  store(collection: string, key: string, value: unknown): void;
  query(collection: string, filter?: Record<string, unknown>, limit?: number): StructuredEntry[];
  remove(collection: string, key: string): boolean;
  list(collection: string): string[];
  collections(): Array<{ collection: string; count: number }>;
  close(): void;
}

const instances = new Map<string, StructuredStore>();

/**
 * Return (or create) a StructuredStore scoped to the given agentId.
 * Each agent gets its own SQLite database file.
 */
export function getStructuredStore(agentId: string): StructuredStore {
  const existing = instances.get(agentId);
  if (existing) {
    return existing;
  }
  const store = createStructuredStore(agentId);
  instances.set(agentId, store);
  return store;
}

/** Tear down all cached instances (useful for tests). */
export function closeAllStructuredStores(): void {
  for (const store of instances.values()) {
    store.close();
  }
  instances.clear();
}

function resolveDbPath(agentId: string): string {
  const stateDir = resolveStateDir();
  const dataDir = path.join(stateDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const safeName = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataDir, `structured-memory-${safeName}.db`);
}

function createStructuredStore(agentId: string): StructuredStore {
  const sqlite = requireNodeSqlite();
  const dbPath = resolveDbPath(agentId);
  const db = new sqlite.DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      collection TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(collection, key)
    )
  `);

  const stmtUpsert = db.prepare(`
    INSERT INTO kv (collection, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(collection, key)
    DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const stmtCountCollection = db.prepare(`SELECT COUNT(*) AS cnt FROM kv WHERE collection = ?`);

  const stmtSelectAll = db.prepare(
    `SELECT collection, key, value, updated_at FROM kv WHERE collection = ?`,
  );

  const stmtDelete = db.prepare(`DELETE FROM kv WHERE collection = ? AND key = ?`);

  const stmtListKeys = db.prepare(`SELECT key FROM kv WHERE collection = ? ORDER BY key`);

  const stmtCollections = db.prepare(
    `SELECT collection, COUNT(*) AS cnt FROM kv GROUP BY collection ORDER BY collection`,
  );

  const stmtExists = db.prepare(`SELECT 1 FROM kv WHERE collection = ? AND key = ? LIMIT 1`);

  function store(collection: string, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > MAX_VALUE_BYTES) {
      throw new Error(
        `Value for "${collection}/${key}" exceeds maximum size of ${MAX_VALUE_BYTES} bytes`,
      );
    }
    // Check collection size limit (only for inserts, not updates)
    const existsRow = stmtExists.get(collection, key) as Record<string, unknown> | undefined;
    if (!existsRow) {
      const row = stmtCountCollection.get(collection) as { cnt: number };
      if (row.cnt >= MAX_COLLECTION_ENTRIES) {
        throw new Error(
          `Collection "${collection}" has reached the maximum of ${MAX_COLLECTION_ENTRIES} entries`,
        );
      }
    }
    const now = new Date().toISOString();
    stmtUpsert.run(collection, key, json, now);
  }

  function query(
    collection: string,
    filter?: Record<string, unknown>,
    limit?: number,
  ): StructuredEntry[] {
    const rows = stmtSelectAll.all(collection) as Array<{
      collection: string;
      key: string;
      value: string;
      updated_at: string;
    }>;

    let entries: StructuredEntry[] = rows.map((r) => ({
      collection: r.collection,
      key: r.key,
      value: JSON.parse(r.value) as unknown,
      updatedAt: r.updated_at,
    }));

    if (filter && Object.keys(filter).length > 0) {
      entries = entries.filter((entry) => {
        if (typeof entry.value !== "object" || entry.value === null) {
          return false;
        }
        const obj = entry.value as Record<string, unknown>;
        return Object.entries(filter).every(([fk, fv]) => obj[fk] === fv);
      });
    }

    if (typeof limit === "number" && limit > 0) {
      entries = entries.slice(0, limit);
    }

    return entries;
  }

  function remove(collection: string, key: string): boolean {
    const result = stmtDelete.run(collection, key);
    return result.changes > 0;
  }

  function list(collection: string): string[] {
    const rows = stmtListKeys.all(collection) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  function listCollections(): Array<{ collection: string; count: number }> {
    const rows = stmtCollections.all() as Array<{ collection: string; cnt: number }>;
    return rows.map((r) => ({ collection: r.collection, count: r.cnt }));
  }

  function close(): void {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }

  return { store, query, remove, list, collections: listCollections, close };
}
