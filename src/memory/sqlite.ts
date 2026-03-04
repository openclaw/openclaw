import { createRequire } from "node:module";
import { installProcessWarningFilter } from "../infra/warning-filter.js";

const require = createRequire(import.meta.url);

/**
 * Attempts to load SQLite support, falling back to better-sqlite3 if node:sqlite is unavailable.
 * Returns an object with Database and DatabaseSync constructors.
 */
export function requireNodeSqlite(): {
  Database: typeof import("better-sqlite3").Database;
  DatabaseSync: typeof import("better-sqlite3").DatabaseSync;
} {
  installProcessWarningFilter();

  // First try the built-in node:sqlite module (Node.js 22+)
  try {
    const nodeSqlite = require("node:sqlite") as typeof import("node:sqlite");
    return {
      Database: nodeSqlite.Database,
      DatabaseSync: nodeSqlite.DatabaseSync,
    };
  } catch {
    // Node distribution may not include the experimental builtin SQLite module.
    // Try falling back to better-sqlite3 package.
  }

  // Fallback to better-sqlite3 npm package
  try {
    const betterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    return {
      Database: betterSqlite3.Database,
      DatabaseSync: betterSqlite3.DatabaseSync,
    };
  } catch (betterSqlite3Err) {
    const nodeSqliteMessage =
      nodeSqliteErr instanceof Error ? nodeSqliteErr.message : String(nodeSqliteErr);
    const betterSqlite3Message =
      betterSqlite3Err instanceof Error ? betterSqlite3Err.message : String(betterSqlite3Err);

    // Neither node:sqlite nor better-sqlite3 is available.
    throw new Error(
      `SQLite support is unavailable in this Node runtime. Neither node:sqlite nor better-sqlite3 is available. node:sqlite error: ${nodeSqliteMessage}. better-sqlite3 error: ${betterSqlite3Message}. Install better-sqlite3: npm install better-sqlite3`,
      { cause: betterSqlite3Err },
    );
  }
}
