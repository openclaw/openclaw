import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { normalizeWindowsPathPreservingCase } from "./path-guards.js";

export type DatabaseFileIdentity = Readonly<{
  key: string;
  birthtime?: string;
}>;
export type DatabasePathIdentity = DatabaseFileIdentity & Readonly<{ canonicalPath: string }>;

// The physical host policy stays fixed across every admission in this process.
const useDatabaseBirthtime = process.platform !== "linux";

export function databaseFileIdentityKey(file: Pick<BigIntStats, "dev" | "ino">): string {
  return `${file.dev}:${file.ino}`;
}

export function readDatabaseIdentityBirthtime(file: Pick<BigIntStats, "birthtimeNs">): string {
  // Node does not expose Linux STATX_BTIME availability and can substitute ctime.
  // Keep the unknown creation-time value stable across ordinary database writes.
  return useDatabaseBirthtime ? file.birthtimeNs.toString() : "0";
}

/** Native SQLite namespaces are filesystem locators, not distinct database owners. */
export function normalizeDatabasePath(location: string): string {
  const normalized =
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(location) : location;
  // Preserve other path dialects and device namespaces that do not normalize to a drive or UNC.
  return process.platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2})/iu.test(normalized)
    ? location
    : normalized;
}

export function readDatabaseFileIdentity(value: unknown): DatabaseFileIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("key" in value) ||
    typeof value.key !== "string" ||
    !/^file:(?:0|[1-9]\d{0,19}):(?:0|[1-9]\d{0,19})$/.test(value.key) ||
    ("birthtime" in value &&
      value.birthtime !== undefined &&
      (typeof value.birthtime !== "string" || !/^-?(?:0|[1-9]\d{0,29})$/.test(value.birthtime)))
  ) {
    throw new Error("SQLite snapshot requires a captured physical file identity");
  }
  return {
    key: value.key,
    ...("birthtime" in value && typeof value.birthtime === "string"
      ? { birthtime: value.birthtime }
      : {}),
  };
}

export function assertDatabaseFileIdentity(
  file: BigIntStats,
  expected: DatabaseFileIdentity,
): void {
  if (
    !file.isFile() ||
    `file:${databaseFileIdentityKey(file)}` !== expected.key ||
    (expected.birthtime !== undefined && readDatabaseIdentityBirthtime(file) !== expected.birthtime)
  ) {
    throw new Error("SQLite database file identity changed before existing-only open");
  }
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

function missingAncestorParent(ancestor: string, missing: string[], error: unknown): string {
  if (!hasErrnoCode(error, "ENOENT")) {
    throw error;
  }
  missing.unshift(path.basename(ancestor));
  const parent = path.dirname(ancestor);
  if (parent === ancestor) {
    throw error;
  }
  return parent;
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
    const canonicalPath = realpathSync.native(resolvedPath);
    return existingIdentity(file, statSync(canonicalPath, { bigint: true }), canonicalPath);
  }
  const missing: string[] = [];
  let ancestor = resolvedPath;
  while (true) {
    try {
      const canonicalPath = normalizeDatabasePath(
        path.join(realpathSync.native(ancestor), ...missing),
      );
      return { key: `path:${canonicalPath}`, canonicalPath };
    } catch (error) {
      ancestor = missingAncestorParent(ancestor, missing, error);
    }
  }
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
      ancestor = missingAncestorParent(ancestor, missing, error);
    }
  }
}

/** Revalidate the captured file, or keep an observed absence from adopting a replacement. */
export function assertDatabasePathIdentity(
  databasePath: string,
  expected: DatabasePathIdentity,
): void {
  if (expected.key.startsWith("file:")) {
    assertExistingDatabaseIdentity(databasePath, expected.key, expected.birthtime);
  } else if (readDatabasePathIdentitySync(databasePath).key !== expected.key) {
    throw new Error(`SQLite database path identity changed: ${databasePath}`);
  }
}

export function assertExistingDatabaseIdentity(
  databasePath: string,
  expected: string,
  expectedBirthtime?: string,
): void {
  assertDatabaseFileIdentity(statSync(databasePath, { bigint: true }), {
    key: expected,
    birthtime: expectedBirthtime,
  });
}
