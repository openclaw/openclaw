import { createRequire } from "node:module";
import { installProcessWarningFilter } from "../infra/warnings.js";

const require = createRequire(import.meta.url);

export const isBunRuntime: boolean = (process.versions as { bun?: string }).bun !== undefined;

/**
 * Unified SQLite database type that works for both Bun and Node runtimes.
 */
export type SqliteDatabase = import("bun:sqlite").Database | import("node:sqlite").DatabaseSync;

export function requireSqlite(): typeof import("bun:sqlite") | typeof import("node:sqlite") {
  if (isBunRuntime) {
    return require("bun:sqlite") as typeof import("bun:sqlite");
  }
  installProcessWarningFilter();
  return require("node:sqlite") as typeof import("node:sqlite");
}

/** @deprecated Use requireSqlite instead */
export const requireNodeSqlite = requireSqlite;
