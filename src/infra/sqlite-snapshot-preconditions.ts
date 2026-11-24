import fs from "node:fs/promises";
import { pathEntryExists } from "./path-existence.js";

export async function assertRegularSourceFile(
  sourcePath: string,
  requireNonEmptySource: boolean,
): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile()) {
    throw new Error(`SQLite snapshot source must be a regular file: ${sourcePath}`);
  }
  if (requireNonEmptySource && stat.size === 0) {
    throw new Error(`SQLite snapshot source must not be empty: ${sourcePath}`);
  }
}

export async function assertTargetAbsent(targetPath: string): Promise<void> {
  if (await pathEntryExists(targetPath)) {
    throw new Error(`SQLite snapshot target already exists: ${targetPath}`);
  }
}

export function assertSynchronousCallbackResult(result: unknown, label: string): void {
  if (
    result &&
    (typeof result === "object" || typeof result === "function") &&
    // SAFETY: the preceding guard proves a property-bearing object or function.
    typeof (result as { then?: unknown }).then === "function"
  ) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error(`${label} must be synchronous.`);
  }
}
