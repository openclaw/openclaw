import fs from "node:fs";
import path from "node:path";
import { SafeOpenError, openFileWithinRoot } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export const DEFAULT_BROWSER_TMP_DIR = resolvePreferredOpenClawTmpDir();
export const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
export const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
export const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");

function isStrictlyInsideDir(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

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
  if (isStrictlyInsideDir(root, resolved)) {
    return { ok: true, path: resolved };
  }

  // Lexical check failed — on systems where tmp dirs use symlinks
  // (e.g. macOS /tmp → /private/tmp) the CLI may realpath-resolve file
  // paths while the root still uses the unresolved form, or vice-versa.
  // Retry with realpath-resolved root and target.
  try {
    const realRoot = fs.realpathSync(root);
    let effectiveResolved = resolved;
    try {
      effectiveResolved = fs.realpathSync(resolved);
    } catch {
      try {
        const parentReal = fs.realpathSync(path.dirname(resolved));
        effectiveResolved = path.join(parentReal, path.basename(resolved));
      } catch {
        // Parent doesn't exist either — fall through.
      }
    }
    if (isStrictlyInsideDir(realRoot, effectiveResolved)) {
      return { ok: true, path: effectiveResolved };
    }
  } catch {
    // Root doesn't exist — fall through to error.
  }

  return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
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

    const rootDir = path.resolve(params.rootDir);
    const relativePath = path.relative(rootDir, pathResult.path);
    let opened: Awaited<ReturnType<typeof openFileWithinRoot>> | undefined;
    try {
      opened = await openFileWithinRoot({
        rootDir,
        relativePath,
      });
      resolvedPaths.push(opened.realPath);
    } catch (err) {
      if (err instanceof SafeOpenError && err.code === "not-found") {
        // Preserve historical behavior for paths that do not exist yet.
        resolvedPaths.push(pathResult.path);
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
