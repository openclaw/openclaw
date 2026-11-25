import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasErrnoCode } from "./errno.js";
import { readSqliteImageSizeBytes } from "./sqlite-schema-catalog.js";

export const MAX_SNAPSHOT_ATTEMPTS = 10;
export const SQLITE_SOURCE_READ_BUSY_TIMEOUT_MS = 30_000;

const SNAPSHOT_RETRY_BASE_MS = 10;
const SNAPSHOT_RETRY_MAX_MS = 80;

export function sqliteSnapshotSourceFileSize(pathname: string): number {
  try {
    const stat = fs.statSync(pathname);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

/** Native backups copy logical pages; raw copies retain the complete recovery family. */
export function assertSqliteSnapshotSpace(
  source: string | DatabaseSync,
  destination: string,
): void {
  const requiredBytes =
    typeof source === "string"
      ? ["", "-wal", "-journal"].reduce(
          (bytes, suffix) => bytes + sqliteSnapshotSourceFileSize(source + suffix),
          0,
        )
      : readSqliteImageSizeBytes(source);
  const space = tryReadDiskSpace(destination);
  if (space && space.availableBytes < requiredBytes) {
    throw Object.assign(
      new Error(
        `SQLite read-only snapshot needs ${formatDiskSpaceBytes(requiredBytes)} (${requiredBytes} bytes) near ${destination}, but only ${formatDiskSpaceBytes(space.availableBytes)} (${space.availableBytes} bytes) is available. Free disk space before retrying.`,
      ),
      { code: "ENOSPC" },
    );
  }
}

export function waitForSnapshotRetrySync(attempt: number): void {
  if (attempt + 1 >= MAX_SNAPSHOT_ATTEMPTS) {
    return;
  }
  const delayMs = Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_BASE_MS * 2 ** attempt);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}
