import { FsSafeError } from "@openclaw/fs-safe/errors";
import { createPrivateSqliteDirectory } from "../infra/sqlite-private-directory.js";

export function isPrivateDirectoryAlreadyExists(error: unknown): boolean {
  return process.platform === "win32"
    ? error instanceof FsSafeError && error.code === "already-exists"
    : (error as NodeJS.ErrnoException).code === "EEXIST"; // SAFETY: POSIX fs.mkdir errors.
}

export async function createPrivateSnapshotDirectory(directoryPath: string): Promise<void> {
  try {
    await createPrivateSqliteDirectory(directoryPath);
  } catch (error) {
    if (isPrivateDirectoryAlreadyExists(error)) {
      throw new Error(`SQLite snapshot directory already exists: ${directoryPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}
