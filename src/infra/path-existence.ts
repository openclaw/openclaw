import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode, isNotFoundPathError } from "@openclaw/fs-safe/path";
import { ignoreMissingPath, isMissingPathError } from "./errno.js";

/** Resolve existing links, or use the absolute lexical path when probing fails. */
export async function realpathOrResolve(candidate: string): Promise<string> {
  try {
    return await fsPromises.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** Resolve an absolute path through a readable ancestor; this is not a containment check. */
export function realpathExistingAncestorSync(candidate: string): string | undefined {
  const suffix: string[] = [];
  let current = candidate;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...suffix.toReversed());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

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
  return (await lstatIfExists(filePath, "ENOENT")) !== undefined;
}

/** Inspect links themselves; callers decide whether a non-directory ancestor counts as absent. */
export async function lstatIfExists(
  filePath: string,
  missingErrors: "ENOENT" | "ENOENT_OR_ENOTDIR" = "ENOENT_OR_ENOTDIR",
): Promise<fs.Stats | undefined> {
  try {
    return await fsPromises.lstat(filePath);
  } catch (error) {
    if (
      missingErrors === "ENOENT" ? hasNodeErrorCode(error, "ENOENT") : isNotFoundPathError(error)
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Follow links; only ENOENT means absent, while all other filesystem failures propagate. */
export async function statIfExists(filePath: string): Promise<fs.Stats | undefined> {
  return fsPromises.stat(filePath).catch(ignoreMissingPath);
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

/** X_OK admits searchable directories too; executable discovery also needs a regular target. */
export async function executableFileExists(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (
    (await canAccess(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)) &&
    (await safeStat(filePath))?.isFile() === true
  );
}

/** X_OK admits searchable directories too; discovery requires a regular target. */
export function executableFileExistsSync(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    return (
      fs.statSync(filePath).isFile() &&
      canAccessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)
    );
  } catch {
    return false;
  }
}
