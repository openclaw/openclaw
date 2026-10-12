import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { normalizeWindowsPathPreservingCase } from "./path-guards.js";

export type DatabasePathIdentity = Readonly<{
  key: string;
  canonicalPath: string;
  birthtime?: string;
}>;

/** Native SQLite namespaces are filesystem locators, not distinct database owners. */
export function normalizeDatabasePath(location: string): string {
  const normalized =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(location) : location;
  // Preserve other path dialects and device namespaces that do not normalize to a drive or UNC.
  return process.platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2})/iu.test(normalized)
    ? location
    : normalized;
}

// The physical host policy stays fixed across every admission in this process.
const useDatabaseBirthtime = process.platform !== "linux";

export function databaseFileIdentityKey(file: Pick<BigIntStats, "dev" | "ino">): string {
  return `${file.dev}:${file.ino}`;
}

export function readDatabaseIdentityBirthtime(file: BigIntStats): string {
  // Node does not expose Linux STATX_BTIME availability and can substitute ctime.
  // Keep the unknown creation-time value stable across ordinary database writes.
  return useDatabaseBirthtime ? file.birthtimeNs.toString() : "0";
}

function existingIdentity(
  file: BigIntStats,
  canonicalFile: BigIntStats,
  canonicalPath: string,
): DatabasePathIdentity {
  if (!file.isFile()) {
    throw new Error("SQLite worker database path must identify a regular file");
  }
  if (
    file.dev !== canonicalFile.dev ||
    file.ino !== canonicalFile.ino ||
    readDatabaseIdentityBirthtime(file) !== readDatabaseIdentityBirthtime(canonicalFile)
  ) {
    throw new Error("SQLite database pathname changed during admission");
  }
  return {
    key: `file:${databaseFileIdentityKey(file)}`,
    canonicalPath: normalizeDatabasePath(canonicalPath),
    birthtime: readDatabaseIdentityBirthtime(file),
  };
}

/** In-process owner key only; never rewrite a configured or persisted database locator. */
export function resolveDatabasePathKey(databasePath: string): string {
  const missing: string[] = [];
  let ancestor = path.resolve(databasePath);
  while (true) {
    try {
      return normalizeDatabasePath(path.join(realpathSync.native(ancestor), ...missing));
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      ancestor = parent;
    }
  }
}

/** Inspect a native-owner path without replacing its diagnostic for a non-file target. */
export function inspectDatabasePathIdentitySync(
  databasePath: string,
): DatabasePathIdentity | undefined {
  const resolvedPath = path.resolve(databasePath);
  let file: BigIntStats | undefined;
  try {
    file = statSync(resolvedPath, { bigint: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  if (file) {
    if (!file.isFile()) {
      return undefined;
    }
    const canonicalPath = resolveDatabasePathKey(resolvedPath);
    return existingIdentity(file, statSync(canonicalPath, { bigint: true }), canonicalPath);
  }
  const canonicalPath = resolveDatabasePathKey(resolvedPath);
  return { key: `path:${canonicalPath}`, canonicalPath };
}

/** Capture identity before yielding; worker admission requires a regular file or absent path. */
export function readDatabasePathIdentitySync(databasePath: string): DatabasePathIdentity {
  const identity = inspectDatabasePathIdentitySync(databasePath);
  if (!identity) {
    throw new Error("SQLite worker database path must identify a regular file");
  }
  return identity;
}

/** Inspect retained aliases only while binding a newly observed database path. */
export function findChangedDatabasePaths(
  paths: Iterable<string>,
  observed: DatabasePathIdentity,
): string[] {
  return [...paths].filter(
    (pathname) => inspectDatabasePathIdentitySync(pathname)?.key !== observed.key,
  );
}

export async function readDatabasePathIdentity(
  databasePath: string,
): Promise<DatabasePathIdentity> {
  const file = await stat(databasePath, { bigint: true }).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (file) {
    try {
      const canonicalPath = await realpath(databasePath);
      const canonicalFile = await stat(canonicalPath, { bigint: true });
      return existingIdentity(file, canonicalFile, canonicalPath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        throw new Error("SQLite database pathname changed during admission", { cause: error });
      }
      throw error;
    }
  }
  // Resolve the existing ancestor before a first open so directory aliases share admission.
  const missing: string[] = [];
  let ancestor = databasePath;
  while (true) {
    try {
      const canonicalPath = normalizeDatabasePath(path.join(await realpath(ancestor), ...missing));
      return { key: `path:${canonicalPath}`, canonicalPath };
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      ancestor = parent;
    }
  }
}

export function assertExistingDatabaseIdentity(
  databasePath: string,
  expected: string,
  expectedBirthtime?: string,
): void {
  const file = statSync(databasePath, { bigint: true });
  if (
    !file.isFile() ||
    `file:${file.dev}:${file.ino}` !== expected ||
    (expectedBirthtime !== undefined && readDatabaseIdentityBirthtime(file) !== expectedBirthtime)
  ) {
    throw new Error("SQLite database file identity changed before existing-only open");
  }
}
