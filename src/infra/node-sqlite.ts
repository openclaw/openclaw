// Loads node:sqlite with OpenClaw warning handling.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ensureSqliteLibrarySelected,
  getSqliteRuntimeCapabilities,
  SQLITE_NATIVE_RUNTIME_ADMISSION_KEY,
} from "./bun-sqlite-library.js";
import { formatErrorMessage } from "./errors.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";
import { compareValidSemver } from "./semver.js";
import {
  bindSqliteDatabaseAdmission,
  prepareSqliteDatabaseAdmission,
} from "./sqlite-database-admission.js";
import {
  probeSqliteIteratorBehavior,
  type SqliteIteratorBehavior,
} from "./sqlite-native-observer.js";
import { registerSqliteReaderConnection } from "./sqlite-reader-lifecycle.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";
import { trackSqliteSchema } from "./sqlite-schema-facts.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
let validatedSqliteModule:
  | { sqlite: typeof import("node:sqlite"); iteratorBehavior: SqliteIteratorBehavior }
  | undefined;
let extensionLoadingSupported = false;
let jsonbSupported = false;
// Unqualified runtimes cannot confirm native disposal until the owning worker exits.
export let bunSqliteNativeCleanupPending = false;

type NodeSqliteDatabaseOptions = ConstructorParameters<
  typeof import("node:sqlite").DatabaseSync
>[1];

export function resolveSqliteFilesystemPath(pathname: string): string {
  if (process.platform !== "win32") {
    return pathname;
  }
  // Node's fs APIs normalize long paths, but node:sqlite passes filesystem
  // names directly to SQLite's Windows VFS.
  return path.toNamespacedPath(path.resolve(pathname));
}

export function resolveNodeSqliteLocation(location: string): string {
  if (location === "" || location === ":memory:" || location.startsWith("file:")) {
    return location;
  }
  return resolveSqliteFilesystemPath(location);
}

/** Preserve native Windows path prefixes before adding SQLite URI parameters. */
function resolveSqliteFileUriPath(pathname: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const namespacedPath = path.win32.toNamespacedPath(path.win32.resolve(pathname));
    // SQLite separates the query before decoding the Windows namespace prefix.
    return `file:${encodeURIComponent(namespacedPath)}`;
  }
  return pathToFileURL(path.resolve(pathname)).href;
}

/** Open an existing writable database without SQLite's create-if-missing flag. */
export function resolveExistingSqliteFileUri(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${resolveSqliteFileUriPath(pathname, platform)}?mode=rw`;
}

/** Build an immutable SQLite URI without losing the Windows long-path namespace. */
export function resolveImmutableSqliteFileUri(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${resolveSqliteFileUriPath(pathname, platform)}?mode=ro&immutable=1`;
}

function assertSqliteWalResetSafeVersion(version: string, nodeVersion: string): void {
  if (isSqliteWalResetSafeVersion(version)) {
    return;
  }
  const variables = (process.config as { variables?: Record<string, unknown> } | undefined)
    ?.variables;
  const isShared =
    variables?.node_shared_sqlite === true || variables?.node_shared_sqlite === "true";
  const wording = isShared ? "uses shared system" : "embeds";
  const remediation = isShared
    ? "Upgrade the system SQLite library to one of those safe versions, or use a Node build embedding a safe version."
    : "Upgrade to Node 24.16.0+ or 26.1.0+ before retrying.";
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
  extensionLoadingSupported: boolean;
  iteratorBehavior: SqliteIteratorBehavior;
};

function parseSqliteNativeRuntimeAdmission(
  value: unknown,
): SqliteNativeRuntimeAdmission | undefined {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.version !== "string" ||
    typeof value.extensionLoadingSupported !== "boolean" ||
    !isRecord(value.iteratorBehavior) ||
    typeof value.iteratorBehavior.nextAfterDoneIsTerminal !== "boolean" ||
    typeof value.iteratorBehavior.returnAfterDoneIsInert !== "boolean"
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
    extensionLoadingSupported: value.extensionLoadingSupported,
    iteratorBehavior: {
      nextAfterDoneIsTerminal: value.iteratorBehavior.nextAfterDoneIsTerminal,
      returnAfterDoneIsInert: value.iteratorBehavior.returnAfterDoneIsInert,
    },
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

function assertSafeSqliteRuntime(sqlite: typeof import("node:sqlite")): SqliteIteratorBehavior {
  if (validatedSqliteModule?.sqlite === sqlite) {
    return validatedSqliteModule.iteratorBehavior;
  }
  const inherited = isMainThread
    ? undefined
    : parseSqliteNativeRuntimeAdmission(getEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY));
  // Worker isolates share the selected native library; another process must probe its own load.
  if (inherited) {
    assertSqliteWalResetSafeVersion(inherited.version, process.versions.node);
    jsonbSupported = (compareValidSemver(inherited.version, "3.45.0") ?? -1) >= 0;
    extensionLoadingSupported = inherited.extensionLoadingSupported;
    validatedSqliteModule = { sqlite, iteratorBehavior: inherited.iteratorBehavior };
    return inherited.iteratorBehavior;
  }
  // Shared-SQLite Node builds can load a different library than process.versions
  // reports, so query the loaded library before callers open real state databases.
  const database = new sqlite.DatabaseSync(":memory:");
  let version: string;
  let extensions: boolean;
  let iteratorBehavior: SqliteIteratorBehavior;
  try {
    const statement = database.prepare(
      "SELECT sqlite_version() AS version, sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted",
    );
    const row = statement.get() as { version?: unknown; omitted?: unknown } | undefined;
    version = typeof row?.version === "string" ? row.version : "unknown";
    assertSqliteWalResetSafeVersion(version, process.versions.node);
    extensions = row?.omitted === 0;
    iteratorBehavior = probeSqliteIteratorBehavior(statement);
  } finally {
    database.close();
  }
  jsonbSupported = (compareValidSemver(version, "3.45.0") ?? -1) >= 0;
  extensionLoadingSupported = extensions;
  validatedSqliteModule = { sqlite, iteratorBehavior };
  setEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY, {
    format: 1,
    runtime: sqliteNativeRuntimeIdentity(),
    version,
    extensionLoadingSupported: extensions,
    iteratorBehavior,
  });
  return iteratorBehavior;
}

// node:sqlite is optional across Node versions, so callers get a clear runtime
// error instead of a low-level module resolution failure.
/** Load node:sqlite after installing the process warning filter. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    ensureSqliteLibrarySelected();
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

/** Open node:sqlite through OpenClaw's runtime and filesystem-location boundary. */
export function openNodeSqliteDatabase(
  location: string,
  options?: NodeSqliteDatabaseOptions,
): import("node:sqlite").DatabaseSync {
  const sqlite = requireNodeSqlite();
  // Callers may pass file: URIs or already-namespaced paths from specialized
  // resolvers; location normalization must remain idempotent for those forms.
  const resolvedLocation = resolveNodeSqliteLocation(location);
  const identity =
    options?.open === false
      ? undefined
      : prepareSqliteDatabaseAdmission(resolvedLocation, { create: options?.readOnly !== true });
  const database = new sqlite.DatabaseSync(resolvedLocation, options ?? {});
  if (database.isOpen) {
    try {
      bindSqliteDatabaseAdmission(database, identity);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  database.open = () => {
    const reopenedIdentity = prepareSqliteDatabaseAdmission(resolvedLocation, {
      create: options?.readOnly !== true,
    });
    sqlite.DatabaseSync.prototype.open.call(database);
    try {
      bindSqliteDatabaseAdmission(database, reopenedIdentity);
    } catch (error) {
      database.close();
      throw error;
    }
  };
  // Schema tracking must precede the statement-cache authorizer wrapper.
  trackSqliteSchema(database, {
    DatabaseSync: sqlite.DatabaseSync,
    StatementSync: sqlite.StatementSync,
    iteratorBehavior: assertSafeSqliteRuntime(sqlite),
  });
  if (!getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources) {
    registerNodeSqliteDisposeCallback(database, () => {
      bunSqliteNativeCleanupPending = true;
    });
  }
  registerSqliteReaderConnection(database);
  return database;
}
