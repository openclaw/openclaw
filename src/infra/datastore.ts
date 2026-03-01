import { FilesystemDatastore } from "./datastore-fs.js";
import { PostgresDatastore } from "./datastore-pg.js";
import { runDatastoreMigrationIfNeeded } from "./migrate-datastore.js";
import { hasStateDbConfigured } from "./state-db.js";

/**
 * Generic key-value datastore interface for document persistence.
 *
 * Keys are the file paths that stores already use (e.g. ~/.openclaw/credentials/auth-profiles.json).
 * The FS implementation uses them as literal file paths; the PG implementation normalizes them as DB keys.
 *
 * Method names encode the serialization format: `readJson` / `writeJson` for
 * structured data, `readText` / `writeText` for raw strings, `readJson5` for
 * human-editable config files.  All synchronous reads return from disk (FS) or
 * an in-memory write-through cache (PG).
 */
export interface Datastore {
  /** Synchronous JSON read — returns parsed JSON or null. */
  readJson(key: string): unknown;

  /**
   * Synchronous JSON read with a fallback default.
   * Returns `{ value, exists }` so callers can distinguish
   * "key absent" from "key present with data".
   */
  readJsonWithFallback(key: string, fallback: unknown): { value: unknown; exists: boolean };

  /**
   * Synchronous read with JSON5 fallback (for human-editable config files).
   * FS impl: tries JSON.parse first, falls back to JSON5.parse.
   * PG impl: reads from cache (always strict JSON).
   * Throws on parse errors so the caller is alerted to corrupt files.
   */
  readJson5(key: string): unknown;

  /** Synchronous raw text read — returns file/value content as a string or null. */
  readText(key: string): string | null;

  /** Synchronous JSON write — persists structured data. */
  writeJson(key: string, data: unknown): void;

  /** Synchronous raw text write — persists a string value. */
  writeText(key: string, content: string): void;

  /** Synchronous JSON write with best-effort backup (FS: copies to .bak after write). */
  writeJsonWithBackup(key: string, data: unknown): void;

  /**
   * Locked read-modify-write for JSON data.  Runs `updater` inside a lock;
   * if `changed` is true, persists `result`.
   * FS impl: file lock.  PG impl: SELECT … FOR UPDATE inside a transaction.
   */
  updateJsonWithLock(
    key: string,
    updater: (data: unknown) => { changed: boolean; result: unknown },
  ): Promise<void>;

  /** Synchronous delete — removes the key/file. */
  delete(key: string): void;

  /**
   * Wait for all pending background writes to be durable.
   * FS impl: no-op (writes are synchronous).
   * PG impl: awaits all in-flight DB writes.
   *
   * Call after critical mutation sequences where data loss on async failure
   * would be unacceptable (e.g. credential migration that scrubs old copies).
   */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export type DatastoreType = "fs" | "database";

/**
 * Resolve the datastore backend type from the environment.
 *
 * Reads `OPENCLAW_DATASTORE` (values: "fs" | "database").
 * Also accepts shorthand "db".
 * Defaults to "fs" when not set — filesystem is the safe default so that
 * misconfigured deployments never silently fall through to a different backend.
 *
 * When "database" is selected, `OPENCLAW_STATE_DB_URL` **must** be present;
 * otherwise a hard error is thrown to prevent the process from booting with
 * an incomplete configuration.
 */
export function resolveDatastoreType(): DatastoreType {
  // TODO: There was a PR comment that requested that we somehow use the name of the database driver as a way to instantiate different types of adapters (datastores)
  const explicit = process.env.OPENCLAW_DATASTORE?.trim().toLowerCase();
  if (explicit === "database" || explicit === "db") {
    if (!hasStateDbConfigured()) {
      throw new Error(
        'OPENCLAW_DATASTORE is set to "database" but OPENCLAW_STATE_DB_URL is not configured. ' +
          "Set OPENCLAW_STATE_DB_URL to a valid database connection string or remove OPENCLAW_DATASTORE to use the filesystem backend.",
      );
    }
    return "database";
  }
  if (explicit === "fs" || explicit === "filesystem") {
    return "fs";
  }
  if (explicit) {
    throw new Error(
      `Invalid OPENCLAW_DATASTORE value: "${explicit}". Expected "fs" or "database".`,
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
    _datastore = type === "database" ? new PostgresDatastore() : new FilesystemDatastore();
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
 *
 * Also runs automatic migration if switching between backends:
 * - filesystem→database: imports filesystem JSON files into PostgreSQL
 * - database→filesystem: restores DB rows back to filesystem (when OPENCLAW_STATE_DB_URL is still set)
 */
export async function initDatastore(): Promise<void> {
  const type = resolveDatastoreType();
  const ds = getDatastore();

  if (type === "database") {
    // Upgrade path: migrate FS data into DB before preloading
    await runDatastoreMigrationIfNeeded("filesystem-to-database");
    if (ds instanceof PostgresDatastore) {
      await ds.ensurePreloaded();
    }
  } else if (type === "fs" && hasStateDbConfigured()) {
    // Downgrade path: DB URL is still configured but datastore is FS —
    // restore DB data to filesystem before the FS datastore reads it.
    await runDatastoreMigrationIfNeeded("database-to-filesystem");
  }
}
