import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import { registerProcessExitCleanup } from "./process-exit-cleanup.js";

export async function removePublicationStagingDirectory(
  stagingDir: string,
  expectedIdentity: FileIdentityStat,
): Promise<void> {
  const currentIdentity = await fs.lstat(stagingDir, { bigint: true }).catch(() => undefined);
  if (!currentIdentity) {
    return;
  }
  if (!currentIdentity.isDirectory() || !sameFileIdentity(expectedIdentity, currentIdentity)) {
    throw new Error(`SQLite publication staging directory changed: ${stagingDir}`);
  }
  const entries = await fs.readdir(stagingDir, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        !entry.isFile() ||
        (entry.name !== "database.sqlite" && !/^\.nfs[\da-f]+$/iu.test(entry.name)),
    )
  ) {
    throw new Error(`SQLite publication staging directory has unexpected contents: ${stagingDir}`);
  }
  const stagedEntry = entries.find((entry) => entry.name === "database.sqlite");
  if (stagedEntry) {
    await fs.unlink(path.join(stagingDir, stagedEntry.name));
  }
  try {
    await fs.rmdir(stagingDir);
  } catch (error) {
    const errorCode = extractErrorCode(error);
    if (errorCode !== "EBUSY" && errorCode !== "ENOTEMPTY") {
      throw error;
    }
    // NFS may keep .nfs aliases until the last native handle closes. Never
    // unlink those aliases; retry only empty-directory removal at process exit.
    registerProcessExitCleanup(() => {
      const current = fsSync.lstatSync(stagingDir, { bigint: true, throwIfNoEntry: false });
      if (current?.isDirectory() && sameFileIdentity(expectedIdentity, current)) {
        fsSync.rmdirSync(stagingDir);
      }
    });
    try {
      getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
        { path: stagingDir, errorCode },
        "SQLite publication staging cleanup deferred until open files are released. If the directory remains after exit, remove it once no process holds its files open.",
      );
    } catch {
      // Diagnostics must not discard an already verified backup.
    }
  }
}
