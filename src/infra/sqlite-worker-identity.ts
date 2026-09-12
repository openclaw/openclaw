import { statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

export async function readDatabasePathIdentity(databasePath: string): Promise<{
  key: string;
  canonicalPath: string;
}> {
  const file = await stat(databasePath, { bigint: true }).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (file) {
    if (!file.isFile()) {
      throw new Error("SQLite worker database path must identify a regular file");
    }
    const canonicalPath = await realpath(databasePath);
    const canonicalFile = await stat(canonicalPath, { bigint: true });
    if (file.dev !== canonicalFile.dev || file.ino !== canonicalFile.ino) {
      throw new Error("SQLite database pathname changed during admission");
    }
    return { key: `file:${file.dev}:${file.ino}`, canonicalPath };
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
