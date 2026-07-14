// Loads node:sqlite with OpenClaw warning handling.
import { createRequire } from "node:module";
import { formatErrorMessage } from "./errors.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
let validatedSqliteModule: typeof import("node:sqlite") | undefined;

// Node may expose process.config.variables flags as boolean, number, or
// string ("true"/"false"); keep the raw union so callers can pass host metadata
// without pre-coercion.
export type NodeSharedSqliteFlag = boolean | number | string | undefined;

/** Normalize Node shared-SQLite build metadata to a closed tri-state. */
export function normalizeNodeSharedSqliteFlag(
  sharedFlag: NodeSharedSqliteFlag,
): boolean | undefined {
  if (sharedFlag === true || sharedFlag === 1 || sharedFlag === "true") {
    return true;
  }
  if (sharedFlag === false || sharedFlag === 0 || sharedFlag === "false") {
    return false;
  }
  // Absent or unrecognized metadata: caller keeps neutral diagnostic wording.
  return undefined;
}

/** Read Node's compile-time shared-SQLite flag when present. */
export function readNodeSharedSqliteFlag(): NodeSharedSqliteFlag {
  return (
    process.config?.variables as { node_shared_sqlite?: boolean | number | string } | undefined
  )?.node_shared_sqlite;
}

/**
 * Describe how Node is linked to the *loaded* SQLite library for diagnostics.
 * Shared builds can report a different process.versions.sqlite than sqlite_version();
 * only claim "embeds" when build metadata confirms a non-shared Node SQLite.
 */
export function describeLoadedSqliteRuntime(
  version: string,
  nodeVersion: string,
  // Required (no default): callers must pass explicit metadata so `undefined`
  // means "flag unavailable", not "read process.config again".
  sharedFlag: NodeSharedSqliteFlag,
): string {
  const shared = normalizeNodeSharedSqliteFlag(sharedFlag);
  if (shared === true) {
    return (
      `Node ${nodeVersion} is using shared SQLite ${version} ` +
      `(loaded library; process.versions.sqlite may differ)`
    );
  }
  if (shared === false) {
    return `Node ${nodeVersion} embeds SQLite ${version}`;
  }
  // Build metadata unavailable/unrecognized: neutral wording from the loaded library.
  return `Node ${nodeVersion} is using SQLite ${version}`;
}

function assertSqliteWalResetSafeVersion(version: string, nodeVersion: string): void {
  if (isSqliteWalResetSafeVersion(version)) {
    return;
  }
  throw new Error(
    `OpenClaw requires SQLite 3.51.3+ (or patched 3.50.7+/3.44.6+) for WAL safety; ` +
      `${describeLoadedSqliteRuntime(version, nodeVersion, readNodeSharedSqliteFlag())}, which is affected by the upstream WAL-reset ` +
      "database corruption bug. Upgrade to Node 22.22.3+, 24.15.0+, or 25.9.0+ before retrying.",
  );
}

function assertSafeSqliteRuntime(sqlite: typeof import("node:sqlite")): void {
  if (validatedSqliteModule === sqlite) {
    return;
  }
  // Shared-SQLite Node builds can load a different library than process.versions
  // reports, so query the loaded library before callers open real state databases.
  const database = new sqlite.DatabaseSync(":memory:");
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    const version = typeof row?.version === "string" ? row.version : "unknown";
    assertSqliteWalResetSafeVersion(version, process.versions.node);
    validatedSqliteModule = sqlite;
  } finally {
    database.close();
  }
}

// node:sqlite is optional across Node versions, so callers get a clear runtime
// error instead of a low-level module resolution failure.
/** Load node:sqlite after installing the process warning filter. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    assertSafeSqliteRuntime(sqlite);
    return sqlite;
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(`SQLite support is unavailable or unsafe in this Node runtime. ${message}`, {
      cause: err,
    });
  }
}
