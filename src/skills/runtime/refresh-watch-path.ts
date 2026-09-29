import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { SKILL_SOURCE_ORIGIN_FILENAME } from "../loading/skill-entry-metadata-path.js";

export function isTrustedSymlinkSkillTarget(
  source: string,
  rootRealPath: string,
  targetRealPath: string,
  allowedSymlinkTargetRealPaths: readonly string[],
): boolean {
  if (source === "openclaw-managed" || source === "agents-skills-personal") {
    return true;
  }
  return (
    isPathInside(rootRealPath, targetRealPath) ||
    allowedSymlinkTargetRealPaths.some((root) => isPathInside(root, targetRealPath))
  );
}

export function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const root = path.parse(normalized).root;
  const trimmed = normalized.replace(/\/+$/, "");
  // A missing path can anchor at a drive root; C: would watch the drive's cwd.
  return trimmed.length < root.length ? root : trimmed;
}

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

export const isIgnoredSkillsWatchPath = (candidate: string): boolean =>
  DEFAULT_SKILLS_WATCH_IGNORED.some((pattern) => pattern.test(candidate));

export function isSkillDiscoveryFileWatchPath(watchPath: string): boolean {
  const basename = path.posix.basename(watchPath.replaceAll("\\", "/"));
  // Source-origin parents can be contained symlink aliases of the metadata directory.
  return (
    (basename === "SKILL.md" || basename === SKILL_SOURCE_ORIGIN_FILENAME) &&
    !DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))
  );
}

export function readBudgetedDirEntries(
  dir: string,
  maxEntries: number,
):
  | { ok: true; entries: fs.Dirent[]; scannedEntryCount: number }
  | { ok: false; scannedEntryCount: number } {
  const entries: fs.Dirent[] = [];
  const limit = Math.max(0, maxEntries);
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let scanned = 0; scanned < limit; scanned += 1) {
      const entry = handle.readSync();
      if (!entry) {
        return { ok: true, entries, scannedEntryCount: scanned };
      }
      entries.push(entry);
    }
    return { ok: true, entries, scannedEntryCount: limit };
  } catch {
    return { ok: false, scannedEntryCount: 0 };
  } finally {
    handle?.closeSync();
  }
}
