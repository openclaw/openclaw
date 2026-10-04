// Native open/close and physical identity admission share one owner.
import { realpathSync, statSync, type BigIntStats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import { withSqliteNativeOpen } from "../infra/sqlite-error-diagnostics.js";
import {
  assertExistingDatabaseIdentity,
  databaseFileIdentityKey,
  normalizeDatabasePath,
  readDatabaseIdentityBirthtime,
} from "../infra/sqlite-worker-identity.js";

/** The physical file a live handle actually has open, not whatever now sits at its pathname. */
export type OpenedStateDatabaseIdentity = Readonly<{
  key: string;
  birthtime: string;
  canonicalPath: string;
}>;

/**
 * Bound only when the identity observed immediately before the native open and immediately after it
 * describe the same regular file, so a caller that reuses this binding is naming the file this
 * connection proved rather than a file renamed over the path afterwards. Binding never fails an
 * open: an unbindable handle simply has no identity, which callers must read as "no receipt".
 */
const openedIdentities = new WeakMap<DatabaseSync, OpenedStateDatabaseIdentity>();

export function getOpenedStateDatabaseIdentity(
  database: DatabaseSync,
): OpenedStateDatabaseIdentity | undefined {
  return openedIdentities.get(database);
}

function statStateDatabaseFile(pathname: string): BigIntStats | undefined {
  try {
    return statSync(pathname, { bigint: true });
  } catch {
    return undefined;
  }
}

function sameStateDatabaseFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    // Linux gets a fixed "0" from this policy, so the descriptor pin held by the receipt owner,
    // not creation time, is what makes a reused inode undetectable-free there.
    readDatabaseIdentityBirthtime(left) === readDatabaseIdentityBirthtime(right)
  );
}

/**
 * Record the identity of the file the native open actually attached to.
 *
 * Residual: a rename of another file over the path and back inside this bracket is not detectable,
 * because both stats then describe the original file. Every other identity change -- a replacement,
 * a recreation, a non-file target, a path that stopped resolving -- records nothing, and a handle
 * without a binding can never mint an integrity receipt.
 */
function bindOpenedStateDatabaseIdentity(
  database: DatabaseSync,
  pathname: string,
  before: BigIntStats | undefined,
): void {
  if (!before) {
    return;
  }
  try {
    const after = statSync(pathname, { bigint: true });
    if (!sameStateDatabaseFile(before, after)) {
      return;
    }
    const canonicalPath = normalizeDatabasePath(realpathSync.native(pathname));
    const canonicalFile = statSync(canonicalPath, { bigint: true });
    if (!sameStateDatabaseFile(after, canonicalFile)) {
      return;
    }
    openedIdentities.set(database, {
      key: `file:${databaseFileIdentityKey(after)}`,
      birthtime: readDatabaseIdentityBirthtime(after),
      canonicalPath,
    });
  } catch {
    // A failed bind means "no receipt", never a failed open.
  }
}

type StateDatabaseOpenOptions = {
  existingOnly?: boolean;
  expectedIdentity?: string;
  readOnly?: boolean;
  timeout?: number;
  enableForeignKeyConstraints?: false;
};

export function openTrackedStateDatabase(
  pathname: string,
  options?: StateDatabaseOpenOptions,
): DatabaseSync {
  const result = openTrackedStateDatabaseResult(pathname, options);
  if (result.status === "unavailable") {
    throw result.error;
  }
  return result.database;
}

/** Native open failure is an ordinary read failure; admitted handles retain their own cleanup. */
export function openTrackedStateDatabaseResult(
  pathname: string,
  options?: StateDatabaseOpenOptions,
): { status: "available"; database: DatabaseSync } | { status: "unavailable"; error: unknown } {
  assertStateDatabaseAccessAllowed(pathname);
  try {
    if (options?.expectedIdentity !== undefined) {
      assertExistingDatabaseIdentity(pathname, options.expectedIdentity);
    }
    const location =
      options?.existingOnly || options?.expectedIdentity !== undefined
        ? resolveExistingSqliteFileUri(pathname)
        : pathname;
    const nativeOptions = options?.readOnly
      ? { readOnly: true, timeout: options.timeout }
      : { enableForeignKeyConstraints: options?.enableForeignKeyConstraints };
    const resolvedPath = path.resolve(pathname);
    const beforeOpen = statStateDatabaseFile(resolvedPath);
    const database = withSqliteNativeOpen(() => openNodeSqliteDatabase(location, nativeOptions));
    bindOpenedStateDatabaseIdentity(database, resolvedPath, beforeOpen);
    try {
      assertStateDatabaseAccessAllowed(pathname);
    } catch (error) {
      openedIdentities.delete(database);
      database.close();
      throw error;
    }
    return { status: "available", database };
  } catch (error) {
    return { status: "unavailable", error };
  }
}

export function closeTrackedStateDatabase(database: DatabaseSync): void {
  openedIdentities.delete(database);
  if (database.isOpen) {
    database.close();
  }
}
