import type BetterSqlite3 from "better-sqlite3";
import { createRequire } from "node:module";
import { installProcessWarningFilter } from "../infra/warnings.js";

const require = createRequire(import.meta.url);

/**
 * Cache the FTS5 availability check result to avoid repeated testing.
 * null = not tested yet, true = available, false = not available
 */
let fts5Available: boolean | null = null;
let useBetterSqlite: boolean | null = null;

/**
 * Test if FTS5 is available in a given SQLite module by creating a temp in-memory
 * database and attempting to create an FTS5 virtual table.
 * Only returns false for FTS5-specific errors (no such module: fts5).
 * Other errors (e.g., can't create DB) are treated as FTS5 being available
 * to avoid unnecessary fallback.
 */
function testFts5Available(SqliteModule: typeof import("node:sqlite")): boolean {
  try {
    const testDb = new SqliteModule.DatabaseSync(":memory:");
    try {
      testDb.exec("CREATE VIRTUAL TABLE test_fts5 USING fts5(content)");
      testDb.exec("DROP TABLE test_fts5");
      testDb.close();
      return true;
    } catch (err) {
      testDb.close();
      // Only treat as FTS5 unavailable if the error specifically mentions fts5
      const message = err instanceof Error ? err.message : String(err);
      if (/no such module:\s*fts5/i.test(message)) {
        return false;
      }
      // Other errors (permissions, etc.) - assume FTS5 is available
      return true;
    }
  } catch {
    // Can't create DB at all - don't fall back, let the real usage fail naturally
    return true;
  }
}

/**
 * Wrapper class for better-sqlite3 that implements the node:sqlite DatabaseSync interface.
 * This allows seamless swapping between node:sqlite and better-sqlite3.
 */
class BetterSqliteDatabaseSync {
  private db: BetterSqlite3.Database;

  constructor(path: string, _options?: { allowExtension?: boolean }) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3") as typeof BetterSqlite3;
    this.db = new Database(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): {
    run: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    iterate: (...args: unknown[]) => IterableIterator<unknown>;
  } {
    const stmt = this.db.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => stmt.iterate(...args),
    };
  }

  close(): void {
    this.db.close();
  }

  enableLoadExtension(_enable: boolean): void {
    // better-sqlite3 doesn't have enableLoadExtension, but loadExtension works directly
  }

  loadExtension(extensionPath: string): void {
    this.db.loadExtension(extensionPath);
  }
}

/**
 * Check if better-sqlite3 is available as an optional dependency.
 */
function isBetterSqliteAvailable(): boolean {
  try {
    require.resolve("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a SQLite module compatible with node:sqlite.
 *
 * This function checks if FTS5 is available in node:sqlite. If not, it falls back
 * to better-sqlite3 (if installed) which typically includes FTS5 support.
 *
 * The fallback is transparent - the returned module has the same interface as node:sqlite.
 */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();

  // If we've already determined we should use better-sqlite3, return it
  if (useBetterSqlite === true) {
    return {
      DatabaseSync:
        BetterSqliteDatabaseSync as unknown as typeof import("node:sqlite").DatabaseSync,
    } as typeof import("node:sqlite");
  }

  // If we've already determined node:sqlite works with FTS5, use it
  if (useBetterSqlite === false) {
    return require("node:sqlite") as typeof import("node:sqlite");
  }

  // First time - test FTS5 availability
  const nodeSqlite = require("node:sqlite") as typeof import("node:sqlite");

  // Test if FTS5 works with node:sqlite
  if (fts5Available === null) {
    fts5Available = testFts5Available(nodeSqlite);
  }

  if (fts5Available) {
    useBetterSqlite = false;
    return nodeSqlite;
  }

  // FTS5 not available in node:sqlite, try better-sqlite3
  if (isBetterSqliteAvailable()) {
    useBetterSqlite = true;
    return {
      DatabaseSync:
        BetterSqliteDatabaseSync as unknown as typeof import("node:sqlite").DatabaseSync,
    } as typeof import("node:sqlite");
  }

  // better-sqlite3 not available, fall back to node:sqlite without FTS5
  useBetterSqlite = false;
  return nodeSqlite;
}
