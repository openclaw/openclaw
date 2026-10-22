import path from "node:path";
import { pathEntryExists } from "./path-existence.js";

/** Link/unlink publication can leave both names. Neither name is a seal until the partial is gone. */
export async function hasPendingUpdateRecoverySeal(directory: string): Promise<boolean> {
  // Retain all pairs, including distinct inodes and malformed partials; do not infer repair authority.
  return await pathEntryExists(path.join(directory, "manifest.json.partial"));
}

export async function assertUpdateRecoverySealComplete(directory: string): Promise<void> {
  if (await hasPendingUpdateRecoverySeal(directory)) {
    throw new Error(
      `Update capture at ${directory} has incomplete publication; retain all evidence for manual inspection.`,
    );
  }
}
