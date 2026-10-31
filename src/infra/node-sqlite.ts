// Opens SQLite files through the native-runtime and database-admission owners.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";
import { rememberSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  bindSqliteDatabaseAdmission,
  prepareSqliteDatabaseAdmission,
} from "./sqlite-database-admission.js";
import { assertSafeSqliteRuntime, requireNodeSqlite } from "./sqlite-native-runtime.js";
import { registerSqliteReaderConnection } from "./sqlite-reader-lifecycle.js";
import { trackSqliteSchema } from "./sqlite-schema-facts.js";

export {
  captureSqliteNativeRuntimeAdmission,
  installSqliteNativeRuntimeAdmission,
  requireNodeSqlite,
  supportsNodeSqliteExtensionLoading,
  supportsNodeSqliteJsonb,
} from "./sqlite-native-runtime.js";

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
  trackSqliteSchema(
    database,
    {
      DatabaseSync: sqlite.DatabaseSync,
      StatementSync: sqlite.StatementSync,
      iteratorBehavior: assertSafeSqliteRuntime(sqlite),
    },
    options?.readOnly !== true,
  );
  if (database.isOpen && options?.timeout !== undefined) {
    rememberSqliteBusyTimeout(database, Math.max(0, options.timeout));
  }
  if (!getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources) {
    registerNodeSqliteDisposeCallback(database, () => {
      bunSqliteNativeCleanupPending = true;
    });
  }
  registerSqliteReaderConnection(database);
  return database;
}
