import fs from "node:fs";
import path from "node:path";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import type { OpenClawConfig } from "../config/config.js";
import { isPathInside as isBoundaryPathInside } from "../infra/path-guards.js";
import { loadRepoOwnershipMap, resolveRepoOwnershipMapPath } from "../sre/repo-ownership/load.js";
import type {
  LoadedRepoOwnershipMap,
  LoadedRepoOwnershipRule,
} from "../sre/repo-ownership/types.js";

export function isPathInside(baseDir: string, targetPath: string): boolean {
  return isBoundaryPathInside(baseDir, targetPath);
}

export function safeRealpathSync(targetPath: string, cache?: Map<string, string>): string | null {
  const cached = cache?.get(targetPath);
  if (cached) {
    return cached;
  }
  try {
    const resolved = fs.realpathSync(targetPath);
    cache?.set(targetPath, resolved);
    return resolved;
  } catch {
    return null;
  }
}

export function safeStatSync(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

export function formatPosixMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export type RepoOwnershipMatch = {
  repo: LoadedRepoOwnershipRule;
  relativePath: string;
  owned: boolean;
};

type RepoOwnershipLoadOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

let repoOwnershipCache:
  | {
      key: string;
      value: Promise<LoadedRepoOwnershipMap>;
    }
  | undefined;

function normalizeRepoOwnershipPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function compileOwnedGlobPatterns(globs: string[]) {
  return compileGlobPatterns({
    raw: globs,
    normalize: normalizeRepoOwnershipPath,
  });
}

export function isOwnedRelativePath(relativePath: string, globs: string[]): boolean {
  return matchesAnyGlobPattern(
    normalizeRepoOwnershipPath(relativePath),
    compileOwnedGlobPatterns(globs),
  );
}

export async function loadRepoOwnershipForRuntime(
  options?: RepoOwnershipLoadOptions,
): Promise<LoadedRepoOwnershipMap> {
  const filePath =
    options?.config?.sre?.repoOwnership?.filePath?.trim() ||
    resolveRepoOwnershipMapPath({ env: options?.env ?? process.env });
  const key = path.resolve(filePath);
  if (repoOwnershipCache?.key === key) {
    return await repoOwnershipCache.value;
  }
  const value = loadRepoOwnershipMap(key);
  repoOwnershipCache = { key, value };
  return await value;
}

export function matchRepoOwnershipPath(
  targetPath: string,
  map: LoadedRepoOwnershipMap,
): RepoOwnershipMatch | undefined {
  const resolvedTarget = path.resolve(targetPath);
  for (const repo of map.repos) {
    if (!isPathInside(repo.resolvedLocalPath, resolvedTarget)) {
      continue;
    }
    const relativePath = normalizeRepoOwnershipPath(
      path.relative(repo.resolvedLocalPath, resolvedTarget),
    );
    return {
      repo,
      relativePath,
      owned: isOwnedRelativePath(relativePath, repo.ownedGlobs),
    };
  }
  return undefined;
}
