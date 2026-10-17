import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { isMissingPathError } from "./errno.js";

/** Only definite absence, including a non-directory ancestor, permits an absent verdict. */
export function pathMayExistSync(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

/** Optional discovery directories may be absent or unreadable. */
export function readDirectoryEntriesSync(filePath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(filePath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Inspect the entry itself, including dangling links; only ENOENT means absent. */
export async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.lstat(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Best-effort discovery probe; inaccessible candidates are not usable. */
export async function canAccess(filePath: string, mode?: number): Promise<boolean> {
  try {
    await fsPromises.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

export function canAccessSync(filePath: string, mode?: number): boolean {
  try {
    fs.accessSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

/** Follow links for optional discovery; filesystem errors make the candidate unavailable. */
export async function safeStat(filePath: string): Promise<fs.Stats | null> {
  return fsPromises.stat(filePath).catch(() => null);
}
