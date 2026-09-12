import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

export type DatabasePathIdentity = Readonly<{
  key: string;
  canonicalPath: string;
}>;

function existingIdentity(
  file: BigIntStats,
  canonicalFile: BigIntStats,
  canonicalPath: string,
): DatabasePathIdentity {
  if (!file.isFile()) {
    throw new Error("SQLite worker database path must identify a regular file");
  }
  if (file.dev !== canonicalFile.dev || file.ino !== canonicalFile.ino) {
    throw new Error("SQLite database pathname changed during admission");
  }
  return { key: `file:${file.dev}:${file.ino}`, canonicalPath };
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
    const canonicalPath = realpathSync(resolvedPath);
    return existingIdentity(file, statSync(canonicalPath, { bigint: true }), canonicalPath);
  }
  const missing: string[] = [];
  let ancestor = resolvedPath;
  while (true) {
    try {
      const canonicalPath = path.join(realpathSync(ancestor), ...missing);
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

/** Capture identity before yielding; worker admission requires a regular file or absent path. */
export function readDatabasePathIdentitySync(databasePath: string): DatabasePathIdentity {
  const identity = inspectDatabasePathIdentitySync(databasePath);
  if (!identity) {
    throw new Error("SQLite worker database path must identify a regular file");
  }
  return identity;
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
    const canonicalPath = await realpath(databasePath);
    const canonicalFile = await stat(canonicalPath, { bigint: true });
    return existingIdentity(file, canonicalFile, canonicalPath);
  }
  // Resolve the existing ancestor before a first open so directory aliases share admission.
  const missing: string[] = [];
  let ancestor = databasePath;
  while (true) {
    try {
      const canonicalPath = path.join(await realpath(ancestor), ...missing);
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

export function assertExistingDatabaseIdentity(databasePath: string, expected: string): void {
  const file = statSync(databasePath, { bigint: true });
  if (!file.isFile() || `file:${file.dev}:${file.ino}` !== expected) {
    throw new Error("SQLite database file identity changed before existing-only open");
  }
}
