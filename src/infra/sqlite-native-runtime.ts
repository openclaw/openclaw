// Owns the loaded native library and its process/worker admission facts.
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ensureSqliteLibrarySelected,
  SQLITE_NATIVE_RUNTIME_ADMISSION_KEY,
} from "./bun-sqlite-library.js";
import { formatErrorMessage } from "./errors.js";
import { compareValidSemver } from "./semver.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
let validatedSqliteModule: typeof import("node:sqlite") | undefined;
let extensionLoadingSupported = false;
let jsonbSupported = false;

function assertSqliteWalResetSafeVersion(version: string, nodeVersion: string): void {
  if (isSqliteWalResetSafeVersion(version)) {
    return;
  }
  const variables: Record<string, unknown> = process.config.variables;
  const isShared = variables.node_shared_sqlite === true || variables.node_shared_sqlite === "true";
  const wording = isShared ? "uses shared system" : "embeds";
  const remediation = isShared
    ? "Upgrade the system SQLite library to one of those safe versions, or use a Node build embedding a safe version."
    : "Upgrade to Node 24.22.1+ or 26.12.1+ before retrying.";
  throw new Error(
    `OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x for WAL safety; ` +
      `Node ${nodeVersion} ${wording} SQLite ${version}, which is affected by the upstream WAL-reset ` +
      `database corruption bug. ${remediation}`,
  );
}

function sqliteNativeRuntimeIdentity() {
  return {
    pid: process.pid,
    executable: process.execPath,
    nodeVersion: process.versions.node,
    bunVersion: process.versions.bun,
    library: ensureSqliteLibrarySelected(),
  };
}

type SqliteNativeRuntimeAdmission = {
  format: 1;
  runtime: ReturnType<typeof sqliteNativeRuntimeIdentity>;
  version: string;
  storageIdentity?: { sourceId: string; compileOptions: string };
  extensionLoadingSupported: boolean;
};

function parseSqliteNativeRuntimeAdmission(
  value: unknown,
): SqliteNativeRuntimeAdmission | undefined {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.version !== "string" ||
    typeof value.extensionLoadingSupported !== "boolean"
  ) {
    return undefined;
  }
  const runtime = sqliteNativeRuntimeIdentity();
  if (!isDeepStrictEqual(value.runtime, runtime)) {
    return undefined;
  }
  return {
    format: 1,
    runtime,
    version: value.version,
    storageIdentity:
      isRecord(value.storageIdentity) &&
      typeof value.storageIdentity.sourceId === "string" &&
      typeof value.storageIdentity.compileOptions === "string"
        ? {
            sourceId: value.storageIdentity.sourceId,
            compileOptions: value.storageIdentity.compileOptions,
          }
        : undefined,
    extensionLoadingSupported: value.extensionLoadingSupported,
  };
}

function safeSqliteNativeRuntimeAdmission(value: unknown) {
  try {
    const admission = parseSqliteNativeRuntimeAdmission(value);
    return admission && isSqliteWalResetSafeVersion(admission.version) ? admission : undefined;
  } catch {
    // Optional transport facts must not replace an already completed database outcome.
    return undefined;
  }
}

/** Reuse a validated isolate fact without opening SQLite or probing the native library. */
export function captureSqliteNativeRuntimeAdmission(): SqliteNativeRuntimeAdmission | undefined {
  return safeSqliteNativeRuntimeAdmission(getEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY));
}

/** Publish to later sibling workers; database authority remains with its existing owners. */
export function installSqliteNativeRuntimeAdmission(value: unknown): void {
  const admission = safeSqliteNativeRuntimeAdmission(value);
  if (admission) {
    setEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY, admission);
  }
}

function assertSafeSqliteRuntime(sqlite: typeof import("node:sqlite")): void {
  if (validatedSqliteModule === sqlite) {
    return;
  }
  const inherited = parseSqliteNativeRuntimeAdmission(
    getEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY),
  );
  // Worker isolates share the selected native library; another process must probe its own load.
  if (inherited) {
    assertSqliteWalResetSafeVersion(inherited.version, process.versions.node);
    jsonbSupported = (compareValidSemver(inherited.version, "3.45.0") ?? -1) >= 0;
    extensionLoadingSupported = inherited.extensionLoadingSupported;
    validatedSqliteModule = sqlite;
    return;
  }
  // Shared-SQLite Node builds can load a different library than process.versions
  // reports, so query the loaded library before callers open real state databases.
  const database = new sqlite.DatabaseSync(":memory:");
  let version: string;
  let storageIdentity: SqliteNativeRuntimeAdmission["storageIdentity"];
  let extensions: boolean;
  try {
    const statement = database.prepare(
      "SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId, " +
        "(SELECT group_concat(compile_options, ',') FROM (SELECT compile_options FROM pragma_compile_options ORDER BY compile_options)) AS compileOptions, " +
        "sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted",
    );
    const row = statement.get();
    version = typeof row?.version === "string" ? row.version : "unknown";
    assertSqliteWalResetSafeVersion(version, process.versions.node);
    // Bind restart proof to the library actually loaded, including custom builds.
    // Missing introspection disables seals, not ordinary full validation.
    if (
      typeof row?.sourceId === "string" &&
      row.sourceId &&
      typeof row.compileOptions === "string"
    ) {
      storageIdentity = { sourceId: row.sourceId, compileOptions: row.compileOptions };
    }
    extensions = row?.omitted === 0;
  } finally {
    database.close();
  }
  jsonbSupported = (compareValidSemver(version, "3.45.0") ?? -1) >= 0;
  extensionLoadingSupported = extensions;
  validatedSqliteModule = sqlite;
  setEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY, {
    format: 1,
    runtime: sqliteNativeRuntimeIdentity(),
    version,
    storageIdentity,
    extensionLoadingSupported: extensions,
  });
}

// node:sqlite is optional across Node versions, so callers get a clear runtime
// error instead of a low-level module resolution failure.
/** Load node:sqlite after installing the process warning filter. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    ensureSqliteLibrarySelected();
    // SAFETY: This fixed builtin exposes node:sqlite; the probe below validates runtime support.
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

/** Whether the loaded SQLite library supports native extensions. */
export function supportsNodeSqliteExtensionLoading(): boolean {
  requireNodeSqlite();
  return extensionLoadingSupported;
}

/** JSONB is absent from the supported SQLite 3.44 maintenance line. */
export function supportsNodeSqliteJsonb(): boolean {
  requireNodeSqlite();
  return jsonbSupported;
}
