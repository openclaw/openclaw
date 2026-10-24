import fs from "node:fs";
import { hasErrnoCode } from "./errno.js";

export const MAX_SNAPSHOT_ATTEMPTS = 10;

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

export function waitForSnapshotRetrySync(attempt: number): void {
  if (attempt + 1 >= MAX_SNAPSHOT_ATTEMPTS) {
    return;
  }
  const delayMs = Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_BASE_MS * 2 ** attempt);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}
