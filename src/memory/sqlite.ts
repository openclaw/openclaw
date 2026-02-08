import { createRequire } from "node:module";
import { installProcessWarningFilter } from "../infra/warnings.js";

const require = createRequire(import.meta.url);

// Detect Bun runtime
const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Provides a unified SQLite interface for both Node.js and Bun runtimes.
 * - Node.js: uses built-in `node:sqlite` (requires --experimental-sqlite flag)
 * - Bun: uses built-in `bun:sqlite` with a compatibility wrapper
 */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  if (isBun) {
    return requireBunSqlite();
  }
  installProcessWarningFilter();
  return require("node:sqlite") as typeof import("node:sqlite");
}

/**
 * Wraps Bun's sqlite to match node:sqlite's DatabaseSync API.
 */
function requireBunSqlite(): typeof import("node:sqlite") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bunSqlite = require("bun:sqlite") as typeof import("bun:sqlite");
  const BunDatabase = bunSqlite.Database;

  // Create a wrapper class that matches node:sqlite's DatabaseSync interface
  class DatabaseSync {
    private db: InstanceType<typeof BunDatabase>;
    private extensionsEnabled = false;

    constructor(path: string, options?: { allowExtension?: boolean }) {
      this.db = new BunDatabase(path);
      // Bun doesn't need allowExtension in constructor, extensions are always loadable
      if (options?.allowExtension) {
        this.extensionsEnabled = true;
      }
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    prepare<T = unknown>(sql: string) {
      return this.db.prepare<T, []>(sql);
    }

    close(): void {
      this.db.close();
    }

    enableLoadExtension(enable: boolean): void {
      // Bun doesn't have this method - extensions are always loadable
      this.extensionsEnabled = enable;
    }

    loadExtension(path: string): void {
      if (!this.extensionsEnabled) {
        throw new Error("Extensions are not enabled. Call enableLoadExtension(true) first.");
      }
      this.db.loadExtension(path);
    }
  }

  // Return an object matching node:sqlite's export structure
  // Use `as unknown as` to bypass strict type checking since Bun's API is compatible at runtime
  return {
    DatabaseSync,
    StatementSync: bunSqlite.Statement,
    constants: {
      SQLITE_CHANGESET_OMIT: 0,
      SQLITE_CHANGESET_REPLACE: 1,
      SQLITE_CHANGESET_ABORT: 2,
      SQLITE_CHANGESET_DATA: 1,
      SQLITE_CHANGESET_NOTFOUND: 2,
      SQLITE_CHANGESET_CONFLICT: 3,
      SQLITE_CHANGESET_CONSTRAINT: 4,
      SQLITE_CHANGESET_FOREIGN_KEY: 5,
    },
    // Stub for backup function (not used in memory module)
    backup: () => {
      throw new Error("backup() is not supported in Bun runtime");
    },
  } as unknown as typeof import("node:sqlite");
}
