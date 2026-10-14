import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

/** Link/unlink publication can leave both names. Neither name is a seal until the partial is gone. */
export async function hasPendingUpdateRecoverySeal(directory: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(directory, "manifest.json.partial"));
    // Retain all pairs, including distinct inodes and malformed partials; do not infer repair authority.
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function assertUpdateRecoverySealComplete(directory: string): Promise<void> {
  if (await hasPendingUpdateRecoverySeal(directory)) {
    throw new Error(
      `Update capture at ${directory} has incomplete publication; retain all evidence for manual inspection.`,
    );
  }
}
