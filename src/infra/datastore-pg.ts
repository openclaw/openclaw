import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Datastore } from "./datastore.js";
import { applyStateDbMigrations } from "./state-db-migrations.js";
import { getStateDbPool } from "./state-db.js";

const KV_TABLE = "openclaw_kv";

/**
 * Derive a stable int64 advisory-lock ID from an arbitrary string key.
 * Uses the first 8 bytes of a SHA-256 hash read as a signed BigInt,
 * then clamps to the safe JS integer range for the pg driver.
 */
function advisoryLockId(key: string): string {
  const hash = crypto.createHash("sha256").update(key).digest();
  // Read as signed 64-bit big-endian, take the absolute value, then reduce
  // modulo MAX_SAFE_INTEGER so the pg driver can send it as a numeric parameter.
  const big = hash.readBigInt64BE(0);
  const abs = big < 0n ? -big : big;
  const clamped = abs % BigInt(Number.MAX_SAFE_INTEGER);
  return clamped.toString();
}

// In-memory write-through cache so that readJson() can be synchronous.
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
 * Strips the home-directory prefix (including separator) so keys are
 * portable across machines.
 *
 * HOME-relative result: `.openclaw/foo.json`  (no leading `/`)
 * Non-HOME absolute:    `/var/lib/openclaw/foo.json`  (leading `/`)
 *
 * The restore side (`migrateDatabaseToFilesystem`) uses `path.isAbsolute`
 * to decide whether to prepend HOME.
 */
export function normalizeKey(key: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (
    home &&
    key.startsWith(home) &&
    (key.length === home.length || key[home.length] === "/" || key[home.length] === "\\")
  ) {
    // Strip HOME + the directory separator so the result is a relative path.
    const sep = key[home.length] === "/" || key[home.length] === "\\" ? 1 : 0;
    return key.slice(home.length + sep);
  }
  return key;
}

export class PostgresDatastore implements Datastore {
  private _preloaded = false;
  private _preloadPromise: Promise<void> | null = null;

  constructor() {
    // Clear stale cache entries from any previous instance (e.g. test teardown
    // via setDatastore(null) followed by a fresh instantiation).
    cache.clear();
  }

  /**
   * Preload all keys into the cache.  Errors propagate so callers like
   * `initDatastore()` can fail fast on connection/migration problems.
   * Safe to call multiple times — only the first invocation triggers a load.
   */
  ensurePreloaded(): Promise<void> {
    if (!this._preloadPromise) {
      this._preloadPromise = this.preloadAll().then(() => {
        this._preloaded = true;
      });
    }
    return this._preloadPromise;
  }

  /** Best-effort background preload for lazy cache warming from readJson(). */
  private _triggerBackgroundPreload(): void {
    if (!this._preloadPromise) {
      this._preloadPromise = this.preloadAll()
        .then(() => {
          this._preloaded = true;
        })
        .catch((err) => {
          console.warn("[postgres-datastore] background preload failed:", err);
          this._preloadPromise = null;
        });
    }
  }

  /**
   * Synchronous JSON read from the in-memory write-through cache.
   * Returns null if the key has never been loaded.
   *
   * Call `preloadAll()` or `ensurePreloaded()` at startup to populate the
   * cache for keys you need to read synchronously.
   */
  readJson(key: string): unknown {
    const dbKey = normalizeKey(key);
    if (!this._preloaded && !cache.has(dbKey)) {
      console.warn(
        `[postgres-datastore] readJson() before preload — call initDatastore() at startup. key=${dbKey}`,
      );
      // Best-effort background preload so future reads hit the cache.
      this._triggerBackgroundPreload();
    }
    const val = cache.get(dbKey);
    return val != null ? structuredClone(val) : null;
  }

  readJsonWithFallback(key: string, fallback: unknown): { value: unknown; exists: boolean } {
    const data = this.readJson(key);
    if (data == null) {
      return { value: fallback, exists: false };
    }
    return { value: data, exists: true };
  }

  readText(key: string): string | null {
    const val = this.readJson(key);
    if (val && typeof val === "object" && "__text" in val) {
      const text = (val as { __text: unknown }).__text;
      return typeof text === "string" ? text : null;
    }
    // Also accept a plain string value in the cache.
    if (typeof val === "string") {
      return val;
    }
    return null;
  }

  readJson5(key: string): unknown {
    // PG always stores strict JSON; no JSON5 fallback needed.
    return this.readJson(key);
  }

  /** Pending background write/delete promises for test assertions. */
  _pendingWrites = new Set<Promise<void>>();

  /** Per-key write chain to preserve mutation ordering. */
  private _writeChains = new Map<string, Promise<void>>();

  /**
   * Wait for all pending background DB writes to complete.
   * Ensures data is durable before proceeding with destructive operations.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this._pendingWrites);
  }

  /** @deprecated Use flush() instead. */
  async _flushPendingWrites(): Promise<void> {
    return this.flush();
  }

  writeJson(key: string, data: unknown): void {
    const dbKey = normalizeKey(key);
    const prev = cache.get(dbKey);
    const hadPrev = cache.has(dbKey);
    const cloned = structuredClone(data);
    // Update cache synchronously so reads see the new value immediately.
    cache.set(dbKey, cloned);
    // Chain DB upsert after any in-flight write for the same key to preserve ordering.
    const chain = (this._writeChains.get(dbKey) ?? Promise.resolve())
      .then(async () => {
        const pool = await ensurePool();
        await pool.query(
          `insert into ${KV_TABLE} (key, data, updated_at)
           values ($1, $2, now())
           on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at`,
          [dbKey, data],
        );
      })
      .catch((err) => {
        // Revert cache only if no newer write has superseded this one.
        if (cache.get(dbKey) === cloned) {
          if (hadPrev) {
            cache.set(dbKey, prev);
          } else {
            cache.delete(dbKey);
          }
        }
        console.warn("[postgres-datastore] background write failed:", err);
      });
    this._writeChains.set(dbKey, chain);
    this._pendingWrites.add(chain);
    void chain.finally(() => {
      this._pendingWrites.delete(chain);
      if (this._writeChains.get(dbKey) === chain) {
        this._writeChains.delete(dbKey);
      }
    });
  }

  writeText(key: string, content: string): void {
    // Wrap raw text in a marker object so readText() can extract it from jsonb.
    this.writeJson(key, { __text: content });
  }

  writeJsonWithBackup(key: string, data: unknown): void {
    this.writeJson(key, data);
  }

  async updateJsonWithLock(
    key: string,
    updater: (data: unknown) => { changed: boolean; result: unknown },
  ): Promise<void> {
    const pool = await ensurePool();
    const dbKey = normalizeKey(key);

    const { value } = await withTransaction(pool, async (client) => {
      // Acquire a transaction-scoped advisory lock so that concurrent callers
      // serialize even when the row does not exist yet.  SELECT ... FOR UPDATE
      // only locks existing rows; without this, two concurrent first-time
      // writers would both read null and race on the upsert.
      await client.query("select pg_advisory_xact_lock($1::bigint)", [advisoryLockId(dbKey)]);

      const row = await client.query<{ data: unknown }>(
        `select data from ${KV_TABLE} where key = $1`,
        [dbKey],
      );

      const current: unknown = row.rows[0]?.data ?? null;
      const { changed, result } = updater(current);

      if (changed) {
        await client.query(
          `insert into ${KV_TABLE} (key, data, updated_at)
           values ($1, $2, now())
           on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at`,
          [dbKey, result],
        );
        return { value: result };
      }
      return { value: current };
    });

    // Always reconcile cache with the authoritative DB state observed under lock.
    if (value !== null) {
      cache.set(dbKey, structuredClone(value));
    } else {
      cache.delete(dbKey);
    }
  }

  delete(key: string): void {
    const dbKey = normalizeKey(key);
    const prev = cache.get(dbKey);
    const hadPrev = cache.has(dbKey);
    // Update cache synchronously so reads see the deletion immediately.
    cache.delete(dbKey);
    // Chain DB delete after any in-flight write for the same key to preserve ordering.
    const chain = (this._writeChains.get(dbKey) ?? Promise.resolve())
      .then(async () => {
        const pool = await ensurePool();
        await pool.query(`delete from ${KV_TABLE} where key = $1`, [dbKey]);
      })
      .catch((err) => {
        // Restore cache only if no newer write/delete has superseded this one.
        if (!cache.has(dbKey) && hadPrev) {
          cache.set(dbKey, prev);
        }
        console.warn("[postgres-datastore] background delete failed:", err);
      });
    this._writeChains.set(dbKey, chain);
    this._pendingWrites.add(chain);
    void chain.finally(() => {
      this._pendingWrites.delete(chain);
      if (this._writeChains.get(dbKey) === chain) {
        this._writeChains.delete(dbKey);
      }
    });
  }

  /**
   * Pre-load a set of keys from the database into the in-memory cache.
   * Call once at startup so that subsequent readJson() calls return data.
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
   * Call once at startup so that subsequent readJson() calls return data
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
    this._preloaded = true;
  }
}
