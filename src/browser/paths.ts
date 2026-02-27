import fs from "node:fs";
import path from "node:path";
import { resolvePreferredBotTmpDir } from "../infra/tmp-bot-dir.js";

export const DEFAULT_BROWSER_TMP_DIR = resolvePreferredBotTmpDir();
export const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
export const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
export const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");

export function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const root = path.resolve(params.rootDir);
  const raw = params.requestedPath.trim();
  if (!raw) {
    if (!params.defaultFileName) {
      return { ok: false, error: "path is required" };
    }
    return { ok: true, path: path.join(root, params.defaultFileName) };
  }
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
  }
  return { ok: true, path: resolved };
}

export function resolvePathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): { ok: true; paths: string[] } | { ok: false; error: string } {
  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = resolvePathWithinRoot({
      rootDir: params.rootDir,
      requestedPath: raw,
      scopeLabel: params.scopeLabel,
    });
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }
    resolvedPaths.push(pathResult.path);
  }
  return { ok: true, paths: resolvedPaths };
}

/**
 * Validates that each requested path is within root and, if the file exists,
 * that it is a regular non-symlink file. Missing files are accepted as
 * lexical in-root paths (for write targets that don't exist yet).
 */
export async function resolveExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const root = path.resolve(params.rootDir);
  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, error: "path is required" };
    }
    const resolved = path.resolve(root, trimmed);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
    }
    // If the file exists, verify it's a regular non-symlink file
    try {
      const stat = fs.lstatSync(resolved);
      if (!stat.isFile()) {
        return {
          ok: false,
          error: `Invalid path: ${trimmed} must be a regular non-symlink file`,
        };
      }
      // Check canonical path after symlink resolution
      const realPath = fs.realpathSync(resolved);
      const realRoot = fs.realpathSync.native(root);
      const realRel = path.relative(realRoot, realPath);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
      }
      resolvedPaths.push(realPath);
    } catch {
      // File does not exist yet - accept as lexical in-root path
      resolvedPaths.push(resolved);
    }
  }
  return { ok: true, paths: resolvedPaths };
}

/**
 * Strict variant of `resolveExistingPathsWithinRoot` that rejects paths
 * to files that do not exist on disk (no lexical fallback).
 */
export async function resolveStrictExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const root = path.resolve(params.rootDir);
  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, error: "path is required" };
    }
    const resolved = path.resolve(root, trimmed);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
    }
    try {
      const stat = fs.lstatSync(resolved);
      if (!stat.isFile()) {
        return {
          ok: false,
          error: `Invalid path: ${trimmed} must be a regular non-symlink file`,
        };
      }
      const realPath = fs.realpathSync(resolved);
      const realRoot = fs.realpathSync.native(root);
      const realRel = path.relative(realRoot, realPath);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
      }
      resolvedPaths.push(realPath);
    } catch {
      return {
        ok: false,
        error: `Invalid path: ${trimmed} must be a regular non-symlink file`,
      };
    }
  }
  return { ok: true, paths: resolvedPaths };
}

/**
 * Validates that a requested write path is within root and its parent
 * directory is a real (non-symlinked) directory.
 */
export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const pathResult = resolvePathWithinRoot(params);
  if (!pathResult.ok) {
    return pathResult;
  }
  const parentDir = path.dirname(pathResult.path);
  try {
    const parentStat = fs.lstatSync(parentDir);
    if (!parentStat.isDirectory()) {
      return {
        ok: false,
        error: `Invalid path: parent of ${params.requestedPath} must stay within ${params.scopeLabel}`,
      };
    }
    if (parentStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Invalid path: parent of ${params.requestedPath} must stay within ${params.scopeLabel}`,
      };
    }
    // Check canonical parent path stays within root
    const realParent = fs.realpathSync(parentDir);
    const root = path.resolve(params.rootDir);
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = root;
    }
    const parentRel = path.relative(realRoot, realParent);
    if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) {
      return {
        ok: false,
        error: `Invalid path: parent of ${params.requestedPath} must stay within ${params.scopeLabel}`,
      };
    }
  } catch {
    // Parent doesn't exist yet - acceptable for write paths
  }
  return pathResult;
}
