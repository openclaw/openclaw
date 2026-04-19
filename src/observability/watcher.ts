import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SourceType } from "./parsers/index.js";

const log = createSubsystemLogger("observability/watcher");

/**
 * Configuration for a watched path.
 */
export type WatchedPath = {
  /** Glob pattern or absolute path to watch */
  pattern: string;
  /** Source type for parsing */
  sourceType: SourceType;
};

/**
 * Event emitted when a file changes.
 */
export type FileChangeEvent = {
  path: string;
  sourceType: SourceType;
  eventType: "add" | "change" | "unlink";
};

/**
 * Callback for file change events.
 */
export type FileChangeCallback = (event: FileChangeEvent) => void;

/**
 * Options for the file watcher.
 */
export type WatcherOptions = {
  /** Debounce threshold in ms before considering file write finished */
  stabilityThreshold?: number;
  /** Poll interval for awaitWriteFinish */
  pollInterval?: number;
  /** Whether to emit events for existing files on start */
  emitExisting?: boolean;
};

const DEFAULT_STABILITY_THRESHOLD = 500;
const DEFAULT_POLL_INTERVAL = 100;

/**
 * Creates a file watcher for observability log files.
 * Based on the pattern from src/memory/manager.ts
 */
export function createWatcher(
  watchedPaths: WatchedPath[],
  onFileChange: FileChangeCallback,
  options: WatcherOptions = {},
): FSWatcher {
  const stabilityThreshold = options.stabilityThreshold ?? DEFAULT_STABILITY_THRESHOLD;
  const pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const ignoreInitial = !options.emitExisting;

  // Build a map from pattern to source type for resolving events
  const patternToSourceType = new Map<string, SourceType>();
  const patterns: string[] = [];

  for (const wp of watchedPaths) {
    patternToSourceType.set(wp.pattern, wp.sourceType);
    patterns.push(wp.pattern);
  }

  const watcher = chokidar.watch(patterns, {
    ignoreInitial,
    awaitWriteFinish: {
      stabilityThreshold,
      pollInterval,
    },
    // Follow symlinks for session directories
    followSymlinks: true,
    // Ignore hidden files except our target files
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      // Allow .openclaw directories
      if (basename === ".openclaw") {
        return false;
      }
      // Ignore other hidden files/dirs
      if (basename.startsWith(".") && !basename.endsWith(".jsonl") && !basename.endsWith(".log")) {
        return true;
      }
      return false;
    },
  });

  const resolveSourceType = (filePath: string): SourceType | null => {
    // Try to match the file path against watched patterns
    for (const wp of watchedPaths) {
      if (matchesPattern(filePath, wp.pattern)) {
        return wp.sourceType;
      }
    }
    return null;
  };

  const emitEvent = (eventType: "add" | "change" | "unlink", filePath: string) => {
    const sourceType = resolveSourceType(filePath);
    if (!sourceType) {
      log.debug(`Ignoring file change (no matching source type): ${filePath}`);
      return;
    }
    log.debug(`File ${eventType}: ${filePath}`, { sourceType });
    onFileChange({
      path: filePath,
      sourceType,
      eventType,
    });
  };

  watcher.on("add", (filePath) => emitEvent("add", filePath));
  watcher.on("change", (filePath) => emitEvent("change", filePath));
  watcher.on("unlink", (filePath) => emitEvent("unlink", filePath));
  watcher.on("error", (error) => {
    log.error(`Watcher error: ${String(error)}`);
  });

  return watcher;
}

/**
 * Checks if a file path matches a glob pattern.
 * Simple implementation for common patterns.
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Handle exact file paths
  if (!pattern.includes("*")) {
    return filePath === pattern || filePath.startsWith(pattern + path.sep);
  }

  // Handle ** glob patterns
  if (pattern.includes("**")) {
    const parts = pattern.split("**");
    const prefix = parts[0]?.replace(/\/$/, "") ?? "";
    const suffix = parts[1]?.replace(/^\//, "") ?? "";

    const matchesPrefix = !prefix || filePath.startsWith(prefix);
    const matchesSuffix = !suffix || filePath.endsWith(suffix);

    return matchesPrefix && matchesSuffix;
  }

  // Handle single * patterns
  const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

/**
 * Resolves glob patterns to actual file paths.
 * Useful for initial file discovery.
 */
export async function resolveWatchedFiles(
  watchedPaths: WatchedPath[],
): Promise<Array<{ path: string; sourceType: SourceType }>> {
  const results: Array<{ path: string; sourceType: SourceType }> = [];

  for (const wp of watchedPaths) {
    const files = await resolveGlobPattern(wp.pattern);
    for (const file of files) {
      results.push({ path: file, sourceType: wp.sourceType });
    }
  }

  return results;
}

/**
 * Resolves a glob pattern to file paths.
 */
async function resolveGlobPattern(pattern: string): Promise<string[]> {
  // Handle non-glob patterns (exact paths)
  if (!pattern.includes("*")) {
    try {
      const stat = await fs.stat(pattern);
      if (stat.isFile()) {
        return [pattern];
      }
      if (stat.isDirectory()) {
        return await walkDirectory(pattern);
      }
    } catch {
      return [];
    }
    return [];
  }

  // Handle glob patterns by walking the base directory
  const parts = pattern.split("**");
  const baseDir = parts[0]?.replace(/\/+$/, "") ?? "";
  const suffix = parts[1]?.replace(/^\/+/, "") ?? "";

  if (!baseDir) {
    return [];
  }

  try {
    const stat = await fs.stat(baseDir);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const allFiles = await walkDirectory(baseDir);
  if (!suffix) {
    return allFiles;
  }

  // Filter by suffix pattern (e.g., "sessions/*.jsonl" or "*.jsonl")
  return allFiles.filter((file) => {
    // Handle patterns like "sessions/*.jsonl" - split into path component and extension
    if (suffix.includes("*")) {
      const suffixParts = suffix.split("*");
      const requiredPath = suffixParts[0]?.replace(/\/+$/, ""); // e.g., "sessions"
      const requiredExt = suffixParts[1] ?? ""; // e.g., ".jsonl"

      const matchesPath = !requiredPath || file.includes(path.sep + requiredPath + path.sep);
      const matchesExt = !requiredExt || file.endsWith(requiredExt);

      return matchesPath && matchesExt;
    }
    return file.endsWith(suffix);
  });
}

/**
 * Recursively walks a directory and returns all files.
 */
async function walkDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await walkDirectory(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch {
    // Ignore errors (permission denied, etc.)
  }

  return files;
}
