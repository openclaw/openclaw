import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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

function resolveSkillsWatchPath(raw: string): string {
  if (process.platform !== "win32") {
    return raw;
  }
  const absolute = path.resolve(raw);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep);
  let cursor = root;
  let index = 0;
  // libuv cannot watch 8.3 directory aliases safely. Expand only the ordinary
  // existing prefix: following a symlink here would bypass followSymlinks:false
  // and the refresh owner's separate trusted skill-target resolution.
  for (const part of parts) {
    const next = path.join(cursor, part);
    try {
      if (fs.lstatSync(next).isSymbolicLink()) {
        break;
      }
    } catch {
      break;
    }
    cursor = next;
    index += 1;
  }
  try {
    const resolved = fs.realpathSync.native(cursor);
    // NTFS can return a delete-pending name if removal races the prefix scan.
    // Keep discovery on the configured path instead of watching that namespace.
    return fs.existsSync(resolved) ? path.join(resolved, ...parts.slice(index)) : raw;
  } catch {
    return raw;
  }
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

function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  usePolling = false,
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  if (usePolling && isSkillDiscoveryFileWatchPath(watchPath)) {
    return false;
  }
  // Regular files are surfaced through raw directory events below. Letting
  // chokidar include discovery files here registers per-file watchers and leaks FDs.
  return true;
}

export function isSkillDiscoveryFileWatchPath(watchPath: string): boolean {
  const basename = path.posix.basename(watchPath.replaceAll("\\", "/"));
  // Source-origin parents can be contained symlink aliases of the metadata directory.
  return (
    (basename === "SKILL.md" || basename === SKILL_SOURCE_ORIGIN_FILENAME) &&
    !DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))
  );
}

export function getRawWatchedPath(details: unknown): string | undefined {
  return isRecord(details) && typeof details.watchedPath === "string"
    ? details.watchedPath
    : undefined;
}

export function rawPathToString(rawPath: unknown): string | undefined {
  if (typeof rawPath === "string") {
    return rawPath || undefined;
  }
  if (Buffer.isBuffer(rawPath)) {
    const decoded = rawPath.toString();
    return decoded || undefined;
  }
  return undefined;
}

export function resolveRawSkillsWatchPath(rawPath: string, details: unknown): string | undefined {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const watchedPath = getRawWatchedPath(details);
  return watchedPath ? path.join(watchedPath, rawPath) : undefined;
}

export function createSkillsWatchPathFilter(root: string, usePolling: boolean) {
  const directorySymlinks = new Set<string>();
  const contains = (watchPath: string) =>
    isPathInside(root, watchPath) || isPathInside(watchPath, root);
  const isSupportingPath = (watchPath: string) =>
    isPathInside(root, watchPath) && !DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath));
  return {
    isSupportingPath,
    isStructuralRaw: (event: string, rawPath: unknown, details: unknown) => {
      const name = rawPathToString(rawPath);
      const changedPath = name
        ? resolveRawSkillsWatchPath(name, details)
        : getRawWatchedPath(details);
      if (changedPath && !isSupportingPath(changedPath)) {
        return false;
      }
      if (!name || !changedPath) {
        return true;
      }
      if (!usePolling) {
        return event !== "change";
      }
      // Chokidar watchFile raw events carry Stats pairs, unlike fs.watch names.
      // Regular supporting-file writes must not keep a directory scan pending.
      return [
        isRecord(details) ? details.curr : undefined,
        isRecord(details) ? details.prev : undefined,
      ].some(
        (stats) =>
          !isRecord(stats) || typeof stats.isDirectory !== "function" || stats.isDirectory(),
      );
    },
    ignored: (
      watchPath: string,
      stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
    ) => {
      if (shouldIgnoreSkillsWatchPath(watchPath, stats, usePolling) || !contains(watchPath)) {
        return true;
      }
      if (stats?.isSymbolicLink?.()) {
        try {
          if (fs.statSync(watchPath).isDirectory()) {
            // Chokidar reports symlink directories as files and omits stats on unlink.
            directorySymlinks.add(toWatchRoot(watchPath));
          }
        } catch {
          // A disappearing link retains its last directory identity until unlink.
        }
      }
      return false;
    },
    isRelevant: (event: string, changedPath: string) => {
      const symlinkKey = toWatchRoot(changedPath);
      const directorySymlink = directorySymlinks.has(symlinkKey);
      if (event === "unlink") {
        directorySymlinks.delete(symlinkKey);
      }
      return (
        (isSkillDiscoveryFileWatchPath(changedPath) ||
          event === "addDir" ||
          event === "unlinkDir" ||
          directorySymlink) &&
        !DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(changedPath)) &&
        contains(changedPath)
      );
    },
  };
}

export function resolveSkillsWatcherUsePolling(): boolean {
  const envPolling = process.env.CHOKIDAR_USEPOLLING;
  if (envPolling === undefined) {
    const platform: string = process.platform;
    // Remove the Bun default after oven-sh/bun#34160 fixes native watcher registration scaling.
    return platform === "os400" || Boolean(process.versions.bun);
  }
  const normalized = envPolling.toLowerCase();
  return Boolean(normalized) && normalized !== "false" && normalized !== "0";
}

export function makeSkillsWatchTarget(
  raw: string,
  depth: number,
  previousWatchRoot?: string,
): { path: string; watchRoot: string; depth: number } {
  // Reconciliation receives an admitted path: only its observation root moves.
  const watchPath = toWatchRoot(previousWatchRoot ? raw : resolveSkillsWatchPath(raw));
  let watchRoot = watchPath;
  while (!fs.existsSync(watchRoot)) {
    const parent = path.dirname(watchRoot);
    if (parent === watchRoot) {
      break;
    }
    watchRoot = parent;
  }
  if (
    previousWatchRoot &&
    previousWatchRoot !== watchRoot &&
    isPathInside(previousWatchRoot, watchRoot)
  ) {
    // Explicit descendant watches bypass Chokidar's followSymlinks:false for
    // intermediate components. Promotion must stop where recursive observation
    // would stop; trusted realpath targets are registered by target preparation.
    let cursor = previousWatchRoot;
    const parts = path.relative(previousWatchRoot, watchRoot).split(path.sep).filter(Boolean);
    for (const part of ["", ...parts]) {
      cursor = path.join(cursor, part);
      try {
        if (!fs.lstatSync(cursor).isSymbolicLink()) {
          continue;
        }
      } catch {
        // An ancestor disappeared between discovery and promotion.
      }
      watchRoot = path.dirname(cursor);
      while (!fs.existsSync(watchRoot) && path.dirname(watchRoot) !== watchRoot) {
        watchRoot = path.dirname(watchRoot);
      }
      break;
    }
  }
  return { path: watchPath, watchRoot: toWatchRoot(watchRoot), depth };
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
