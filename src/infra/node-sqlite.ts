import { createRequire } from "node:module";
import { formatErrorMessage } from "./errors.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);

let nodeSqliteAvailable: boolean | undefined;

/**
 * Check if node:sqlite is available in the current Node.js runtime.
 * This is useful for Homebrew Node.js builds that exclude experimental built-in modules.
 */
export function isNodeSqliteAvailable(): boolean {
  if (nodeSqliteAvailable !== undefined) {
    return nodeSqliteAvailable;
  }
  try {
    require("node:sqlite");
    nodeSqliteAvailable = true;
    return true;
  } catch {
    nodeSqliteAvailable = false;
    return false;
  }
}

export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}
