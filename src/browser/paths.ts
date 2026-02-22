import fs from "node:fs/promises";
import path from "node:path";
import { SafeOpenError, openFileWithinRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export const DEFAULT_BROWSER_TMP_DIR = resolvePreferredOpenClawTmpDir();
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

export async function resolveExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const rootDir = path.resolve(params.rootDir);
  let rootRealPath: string | undefined;
  try {
    rootRealPath = await fs.realpath(rootDir);
  } catch {
    // Keep historical behavior for missing roots and rely on openFileWithinRoot for final checks.
    rootRealPath = undefined;
  }

  const isInRoot = (relativePath: string) =>
    Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

  const resolveExistingRelativePath = async (
    requestedPath: string,
  ): Promise<
    { ok: true; relativePath: string; fallbackPath: string } | { ok: false; error: string }
  > => {
    const raw = requestedPath.trim();
    const lexicalPathResult = resolvePathWithinRoot({
      rootDir,
      requestedPath,
      scopeLabel: params.scopeLabel,
    });
    if (lexicalPathResult.ok) {
      return {
        ok: true,
        relativePath: path.relative(rootDir, lexicalPathResult.path),
        fallbackPath: lexicalPathResult.path,
      };
    }
    if (!rootRealPath || !raw || !path.isAbsolute(raw)) {
      return lexicalPathResult;
    }
    try {
      const resolvedExistingPath = await fs.realpath(raw);
      const relativePath = path.relative(rootRealPath, resolvedExistingPath);
      if (!isInRoot(relativePath)) {
        return lexicalPathResult;
      }
      return {
        ok: true,
        relativePath,
        fallbackPath: resolvedExistingPath,
      };
    } catch {
      return lexicalPathResult;
    }
  };

  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = await resolveExistingRelativePath(raw);
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }

    let opened: Awaited<ReturnType<typeof openFileWithinRoot>> | undefined;
    try {
      opened = await openFileWithinRoot({
        rootDir,
        relativePath: pathResult.relativePath,
      });
      resolvedPaths.push(opened.realPath);
    } catch (err) {
      if (err instanceof SafeOpenError && err.code === "not-found") {
        // Preserve historical behavior for paths that do not exist yet.
        resolvedPaths.push(pathResult.fallbackPath);
        continue;
      }
      return {
        ok: false,
        error: `Invalid path: must stay within ${params.scopeLabel} and be a regular non-symlink file`,
      };
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }
  return { ok: true, paths: resolvedPaths };
}
