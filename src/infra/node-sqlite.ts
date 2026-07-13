// Loads node:sqlite with OpenClaw warning handling.
import { createRequire } from "node:module";
import { formatErrorMessage } from "./errors.js";
import { installProcessWarningFilter } from "./warning-filter.js";

type SqliteVersion = {
  major: number;
  minor: number;
  patch: number;
};

const SQLITE_WAL_RESET_FIXED_VERSION: SqliteVersion = { major: 3, minor: 51, patch: 3 };
const SQLITE_WAL_RESET_BACKPORTS: readonly SqliteVersion[] = [
  { major: 3, minor: 44, patch: 6 },
  { major: 3, minor: 50, patch: 7 },
];
const SQLITE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const require = createRequire(import.meta.url);
let validatedSqliteModule: typeof import("node:sqlite") | undefined;

function parseSqliteVersion(value: string): SqliteVersion | null {
  const match = SQLITE_VERSION_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }
  return { major, minor, patch };
}

function compareSqliteVersions(left: SqliteVersion, right: SqliteVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function isSqliteWalResetSafeVersion(value: string): boolean {
  const version = parseSqliteVersion(value);
  if (!version) {
    return false;
  }
  if (compareSqliteVersions(version, SQLITE_WAL_RESET_FIXED_VERSION) >= 0) {
    return true;
  }
  return SQLITE_WAL_RESET_BACKPORTS.some(
    (backport) =>
      version.major === backport.major &&
      version.minor === backport.minor &&
      version.patch >= backport.patch,
  );
}

function assertSqliteWalResetSafeVersion(version: string, nodeVersion: string): void {
  if (isSqliteWalResetSafeVersion(version)) {
    return;
  }
  throw new Error(
    `OpenClaw requires SQLite 3.51.3+ (or patched 3.50.7+/3.44.6+) for WAL safety; ` +
      `Node ${nodeVersion} embeds SQLite ${version}, which is affected by the upstream WAL-reset ` +
      "database corruption bug. Upgrade to Node 22.22.3+, 24.15.0+, or 25.9.0+ before retrying.",
  );
}

function assertSafeSqliteRuntime(sqlite: typeof import("node:sqlite")): void {
  if (validatedSqliteModule === sqlite) {
    return;
  }
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
