import fs from "node:fs/promises";
import path from "node:path";

/** Git package selectors use portable repository-relative paths, never host paths. */
export function normalizeGitSourceDirectory(directory: string | undefined): string | undefined {
  if (directory === undefined) {
    return undefined;
  }
  if (
    !directory ||
    directory.includes("\\") ||
    directory.includes("\0") ||
    path.posix.isAbsolute(directory) ||
    path.win32.isAbsolute(directory) ||
    /^[a-z]:/i.test(directory) ||
    directory.split("/").includes("..")
  ) {
    throw new Error(
      "Git source directory must be a non-empty repository-relative path without traversal.",
    );
  }
  return path.posix.normalize(directory).replace(/\/$/, "");
}

/** Resolve a normalized selector after checkout, rejecting symlinks out of the fetched source. */
export async function resolveContainedGitSourceDirectory(
  repoDir: string,
  directory: string | undefined,
): Promise<string> {
  if (directory === undefined) {
    return repoDir;
  }
  const root = await fs.realpath(repoDir);
  let selected: string;
  try {
    selected = await fs.realpath(path.join(root, directory));
  } catch (error) {
    throw new Error(`Git source directory not found: ${directory}`, { cause: error });
  }
  const relative = path.relative(root, selected);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Git source directory escapes the repository: ${directory}`);
  }
  if (!(await fs.stat(selected)).isDirectory()) {
    throw new Error(`Git source directory is not a directory: ${directory}`);
  }
  return selected;
}
