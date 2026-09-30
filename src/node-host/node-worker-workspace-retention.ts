import type fs from "node:fs";
import fsp from "node:fs/promises";
import { hasNodeErrorCode } from "../infra/path-guards.js";

export async function listOwnedEntries(parent: string): Promise<fs.Dirent[]> {
  try {
    return (await fsp.readdir(parent, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

export async function listOwnedDirectories(parent: string): Promise<string[]> {
  return (await listOwnedEntries(parent))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
}

export async function removeIfEmpty(target: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await fsp.rmdir(target);
  } catch (error) {
    if (
      !hasNodeErrorCode(error, "ENOENT") &&
      !hasNodeErrorCode(error, "ENOTEMPTY") &&
      !hasNodeErrorCode(error, "EEXIST")
    ) {
      throw error;
    }
  }
}
