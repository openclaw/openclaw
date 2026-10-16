// Loads and saves JSON files with symlink backup handling.
import fs from "node:fs";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { tryReadJsonSync, writeJsonSync } from "@openclaw/fs-safe/json";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";

export function resolveJsonSaveTarget(pathname: string): string {
  if (!fs.lstatSync(pathname, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return pathname;
  }
  const resolved = resolvePathPrefixSync(pathname);
  const target = [resolved.existingPath, ...resolved.unresolvedSegments].join(path.sep);
  fs.statSync(path.dirname(target));
  return target;
}

export function writeJsonTarget(pathname: string, data: unknown): void {
  writeJsonSync(resolveJsonSaveTarget(pathname), data);
}

// oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters -- legacy typed JSON loader alias.
export function loadJsonFileThroughSymlink<T = unknown>(pathname: string): T | undefined {
  let resolved: string;
  try {
    resolved = fs.realpathSync(pathname);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ELOOP")) {
      return undefined;
    }
    throw error;
  }
  return tryReadJsonSync<T>(resolved) ?? undefined;
}
