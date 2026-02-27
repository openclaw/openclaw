import { FilesystemDatastore } from "./datastore-fs.js";
import { PostgresDatastore } from "./datastore-pg.js";
import { hasStateDbConfigured } from "./state-db.js";

/**
 * Generic key-value datastore interface for JSON document persistence.
 *
 * Keys are the file paths that stores already use (e.g. ~/.openclaw/credentials/auth-profiles.json).
 * The FS implementation uses them as literal file paths; the PG implementation normalizes them as DB keys.
 *
 * `read` is synchronous so that the vast majority of callers (which only read)
 * need zero code changes.  The FS impl reads from disk synchronously (same as
 * before).  The PG impl reads from an in-memory write-through cache.
 */
export interface Datastore {
  /** Synchronous read — returns parsed JSON or null. */
  read<T>(key: string): T | null;

  /**
   * Synchronous read with a fallback default.
   * Returns `{ value, exists }` — mirrors the `readJsonFileWithFallback` pattern
   * so callers can distinguish "key absent" from "key present with data".
   */
  readWithFallback<T>(key: string, fallback: T): { value: T; exists: boolean };

  /**
   * Synchronous read with JSON5 fallback (for human-editable config files).
   * FS impl: tries JSON.parse first, falls back to JSON5.parse.
   * PG impl: reads from cache (always strict JSON).
   * Throws on parse errors so the caller is alerted to corrupt files.
   */
  readJson5<T>(key: string): T | null;

  /** Async write — persists JSON data. */
  write(key: string, data: unknown): Promise<void>;

  /** Async write with best-effort backup (FS: copies to .bak after write). */
  writeWithBackup(key: string, data: unknown): Promise<void>;

  /**
   * Locked read-modify-write.  Runs `updater` inside a lock; if `changed` is
   * true, persists `result`.
   * FS impl: file lock.  PG impl: SELECT … FOR UPDATE inside a transaction.
   */
  updateWithLock<T>(
    key: string,
    updater: (data: T | null) => { changed: boolean; result: T },
  ): Promise<void>;

  /** Async delete — removes the key/file. */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export type DatastoreType = "fs" | "postgres";

/**
 * Resolve the datastore backend type from the environment.
 *
 * Reads `OPENCLAW_DATASTORE` (values: "fs" | "postgres").
 * Defaults to "fs" when not set — filesystem is the safe default so that
 * misconfigured deployments never silently fall through to a different backend.
 *
 * When "postgres" is selected, `OPENCLAW_STATE_DB_URL` **must** be present;
 * otherwise a hard error is thrown to prevent the process from booting with
 * an incomplete configuration.
 */
export function resolveDatastoreType(): DatastoreType {
  const explicit = process.env.OPENCLAW_DATASTORE?.trim().toLowerCase();
  if (explicit === "postgres" || explicit === "pg") {
    if (!hasStateDbConfigured()) {
      throw new Error(
        'OPENCLAW_DATASTORE is set to "postgres" but OPENCLAW_STATE_DB_URL is not configured. ' +
          "Set OPENCLAW_STATE_DB_URL to a valid PostgreSQL connection string or remove OPENCLAW_DATASTORE to use the filesystem backend.",
      );
    }
    return "postgres";
  }
  if (explicit === "fs" || explicit === "filesystem") {
    return "fs";
  }
  if (explicit) {
    throw new Error(
      `Invalid OPENCLAW_DATASTORE value: "${explicit}". Expected "fs" or "postgres".`,
    );
  }
  // Default to filesystem — the safest, zero-configuration backend.
  return "fs";
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _datastore: Datastore | null = null;

export function getDatastore(): Datastore {
  if (!_datastore) {
    const type = resolveDatastoreType();
    _datastore = type === "postgres" ? new PostgresDatastore() : new FilesystemDatastore();
  }
  return _datastore;
}

/** Override the active datastore (useful for testing). */
export function setDatastore(ds: Datastore | null): void {
  _datastore = ds;
}

/**
 * Initialize the datastore at startup.
 * For PostgresDatastore, this preloads all keys into the in-memory cache
 * so that synchronous `read()` calls work immediately.
 * For FilesystemDatastore, this is a no-op.
 */
export async function initDatastore(): Promise<void> {
  const ds = getDatastore();
  if (ds instanceof PostgresDatastore) {
    await ds.ensurePreloaded();
  }
}
