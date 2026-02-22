import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_REPO_SCAN_SKIP_DIR_NAMES = new Set([".git", "dist", "node_modules"]);
export const DEFAULT_RUNTIME_SOURCE_ROOTS = ["src", "extensions"] as const;
export const DEFAULT_RUNTIME_SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
export const RUNTIME_SOURCE_SKIP_PATTERNS = [
  /\.test\.tsx?$/,
  /\.test-helpers\.tsx?$/,
  /\.test-utils\.tsx?$/,
  /\.e2e\.tsx?$/,
  /\.d\.ts$/,
  /\/(?:__tests__|tests)\//,
  /\/[^/]*test-helpers(?:\.[^/]+)?\.tsx?$/,
  /\/[^/]*test-utils(?:\.[^/]+)?\.tsx?$/,
] as const;

export type RepoFileScanOptions = {
  roots: readonly string[];
  extensions: readonly string[];
  skipDirNames?: ReadonlySet<string>;
  skipHiddenDirectories?: boolean;
  shouldIncludeFile?: (relativePath: string) => boolean;
};
export type RuntimeSourceScanOptions = {
  roots?: readonly string[];
  extensions?: readonly string[];
};

type PendingDir = {
  absolutePath: string;
};
const runtimeSourceScanCache = new Map<string, Promise<Array<string>>>();

function shouldSkipDirectory(
  name: string,
  options: Pick<RepoFileScanOptions, "skipDirNames" | "skipHiddenDirectories">,
): boolean {
  if (options.skipHiddenDirectories && name.startsWith(".")) {
    return true;
  }
  return (options.skipDirNames ?? DEFAULT_REPO_SCAN_SKIP_DIR_NAMES).has(name);
}

function hasAllowedExtension(fileName: string, extensions: readonly string[]): boolean {
  return extensions.some((extension) => fileName.endsWith(extension));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

function toSortedUnique(values: readonly string[]): Array<string> {
  return [...new Set(values)].toSorted();
}

function getRuntimeScanCacheKey(repoRoot: string, roots: readonly string[]): string {
  return `${repoRoot}::${toSortedUnique(roots).join(",")}`;
}

export async function listRepoFiles(
  repoRoot: string,
  options: RepoFileScanOptions,
): Promise<Array<string>> {
  const files: Array<string> = [];
  const pending: Array<PendingDir> = [];

  for (const root of options.roots) {
    const absolutePath = path.join(repoRoot, root);
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        pending.push({ absolutePath });
      }
    } catch {
      // Skip missing roots. Useful when extensions/ is absent.
    }
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name, options)) {
          pending.push({ absolutePath: path.join(current.absolutePath, entry.name) });
        }
        continue;
      }
      if (!entry.isFile() || !hasAllowedExtension(entry.name, options.extensions)) {
        continue;
      }
      const filePath = path.join(current.absolutePath, entry.name);
      const relativePath = path.relative(repoRoot, filePath);
      if (options.shouldIncludeFile && !options.shouldIncludeFile(relativePath)) {
        continue;
      }
      files.push(filePath);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export function shouldSkipRuntimeSourcePath(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  return RUNTIME_SOURCE_SKIP_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

export async function listRuntimeSourceFiles(
  repoRoot: string,
  options: RuntimeSourceScanOptions = {},
): Promise<Array<string>> {
  const roots = options.roots ?? DEFAULT_RUNTIME_SOURCE_ROOTS;
  const requestedExtensions = toSortedUnique(
    options.extensions ?? DEFAULT_RUNTIME_SOURCE_EXTENSIONS,
  );
  const cacheKey = getRuntimeScanCacheKey(repoRoot, roots);

  let pending = runtimeSourceScanCache.get(cacheKey);
  if (!pending) {
    pending = listRepoFiles(repoRoot, {
      roots,
      extensions: DEFAULT_RUNTIME_SOURCE_EXTENSIONS,
      skipHiddenDirectories: true,
      shouldIncludeFile: (relativePath) => !shouldSkipRuntimeSourcePath(relativePath),
    });
    runtimeSourceScanCache.set(cacheKey, pending);
  }
  const files = await pending;
  return files.filter((filePath) =>
    requestedExtensions.some((extension) => filePath.endsWith(extension)),
  );
}
