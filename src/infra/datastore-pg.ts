import type { Pool, PoolClient } from "pg";
import type { Datastore } from "./datastore.js";
import { applyStateDbMigrations } from "./state-db-migrations.js";
import { getStateDbPool } from "./state-db.js";

const KV_TABLE = "openclaw_kv";

// In-memory write-through cache so that `read()` can be synchronous.
const cache = new Map<string, unknown>();

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

async function ensurePool(): Promise<Pool> {
  const pool = getStateDbPool();
  if (!pool) {
    throw new Error("PostgreSQL state database not configured (OPENCLAW_STATE_DB_URL is not set)");
  }
  await applyStateDbMigrations(pool);
  return pool;
}

/**
 * Normalize a file-system key to a stable DB key.
 * Strips the home-directory prefix so keys are portable across machines.
 */
function normalizeKey(key: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home && key.startsWith(home)) {
    return key.slice(home.length);
  }
  return key;
}

export class PostgresDatastore implements Datastore {
  /**
   * Synchronous read from the in-memory write-through cache.
   * Returns null if the key has never been loaded.
   *
   * Call `preload()` at startup to populate the cache for keys you need
   * to read synchronously.
   */
  read<T>(key: string): T | null {
    const dbKey = normalizeKey(key);
    return (cache.get(dbKey) as T) ?? null;
  }

  readWithFallback<T>(key: string, fallback: T): { value: T; exists: boolean } {
    const data = this.read<T>(key);
    if (data == null) {
      return { value: fallback, exists: false };
    }
    return { value: data, exists: true };
  }

  readJson5<T>(key: string): T | null {
    // PG always stores strict JSON; no JSON5 fallback needed.
    return this.read<T>(key);
  }

  async write(key: string, data: unknown): Promise<void> {
    const dbKey = normalizeKey(key);
    // Update cache first so sync reads see the latest data immediately
    cache.set(dbKey, structuredClone(data));
    const pool = await ensurePool();
    await pool.query(
      `insert into ${KV_TABLE} (key, data, updated_at)
       values ($1, $2, now())
       on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at`,
      [dbKey, data],
    );
  }

  async writeWithBackup(key: string, data: unknown): Promise<void> {
    await this.write(key, data);
  }

  async updateWithLock<T>(
    key: string,
    updater: (data: T | null) => { changed: boolean; result: T },
  ): Promise<void> {
    const pool = await ensurePool();
    const dbKey = normalizeKey(key);

    await withTransaction(pool, async (client) => {
      const locked = await client.query<{ data: T }>(
        `select data from ${KV_TABLE} where key = $1 for update`,
        [dbKey],
      );

      const current: T | null = locked.rows[0]?.data ?? null;
      const { changed, result } = updater(current);

      if (changed) {
        await client.query(
          `insert into ${KV_TABLE} (key, data, updated_at)
           values ($1, $2, now())
           on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at`,
          [dbKey, result],
        );
        cache.set(dbKey, structuredClone(result));
      }
    });
  }

  async delete(key: string): Promise<void> {
    const pool = await ensurePool();
    const dbKey = normalizeKey(key);
    await pool.query(`delete from ${KV_TABLE} where key = $1`, [dbKey]);
    cache.delete(dbKey);
  }

  /**
   * Pre-load a set of keys from the database into the in-memory cache.
   * Call once at startup so that subsequent `read()` calls return data.
   */
  async preload(keys: string[]): Promise<void> {
    const pool = await ensurePool();
    const dbKeys = keys.map(normalizeKey);
    const res = await pool.query<{ key: string; data: unknown }>(
      `select key, data from ${KV_TABLE} where key = any($1)`,
      [dbKeys],
    );
    for (const row of res.rows) {
      cache.set(row.key, structuredClone(row.data));
    }
  }

  /**
   * Pre-load ALL keys from the database into the in-memory cache.
   * Call once at startup so that subsequent `read()` calls return data
   * without needing to know the exact keys ahead of time.
   */
  async preloadAll(): Promise<void> {
    const pool = await ensurePool();
    const res = await pool.query<{ key: string; data: unknown }>(
      `select key, data from ${KV_TABLE}`,
    );
    for (const row of res.rows) {
      cache.set(row.key, structuredClone(row.data));
    }
  }
}
