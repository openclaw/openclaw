import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_REPO_SCAN_SKIP_DIR_NAMES = new Set([".git", "dist", "node_modules"]);

export type RepoFileScanOptions = {
  roots: readonly string[];
  extensions: readonly string[];
  skipDirNames?: ReadonlySet<string>;
  skipHiddenDirectories?: boolean;
  shouldIncludeFile?: (relativePath: string) => boolean;
};

type PendingDir = {
  absolutePath: string;
};

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
