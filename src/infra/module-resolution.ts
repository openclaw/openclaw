import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLogger } from "../logging/logger.js";

function ensureFilePath(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("file://")) {
    try {
      return fileURLToPath(pathOrUrl);
    } catch {
      return pathOrUrl;
    }
  }
  return pathOrUrl;
}

function findInPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    for (const ext of exts) {
      try {
        const p = join(dir, name + ext);
        if (existsSync(p)) {
          return p;
        }
      } catch {
        // ignore invalid paths in PATH
      }
    }
  }
  return null;
}

/**
 * Robustly resolves a file associated with a CLI tool command in the PATH.
 *
 * @param toolCommand - The command name (e.g. "gemini").
 * @param packageName - The name of the package to resolve (e.g. "@google/gemini-cli-core").
 * @param fileRelativePath - The path of the file relative to the package root.
 * @param parentPackageName - Optional: A parent package to resolve through.
 */
export function resolveToolPackageFile(
  toolCommand: string,
  packageName: string,
  fileRelativePath: string,
  parentPackageName?: string,
): string | null {
  const logger = getLogger();
  const toolExec = findInPath(toolCommand);

  if (!toolExec) {
    logger.debug({ toolCommand }, "Tool not found in PATH");
    return null;
  }

  try {
    const resolvedPath = realpathSync(toolExec);
    logger.debug({ toolCommand, toolExec, resolvedPath }, "Resolved tool executable path");

    return resolvePackageFile(resolvedPath, packageName, fileRelativePath, parentPackageName);
  } catch (err) {
    logger.debug({ toolCommand, err }, "Failed to resolve tool path");
    return null;
  }
}

/**
 * Robustly resolves a file within a package, handling potential package manager hoisting
 * or nesting (e.g. pnpm's node_modules structure).
 *
 * @param startPath - The path to start resolution from (e.g. import.meta.url or a file path).
 * @param packageName - The name of the package to resolve.
 * @param fileRelativePath - The path of the file relative to the package root.
 * @param parentPackageName - Optional: A parent package to resolve through (e.g. to find a nested dependency).
 */
export function resolvePackageFile(
  startPath: string,
  packageName: string,
  fileRelativePath: string,
  parentPackageName?: string,
): string | null {
  const logger = getLogger();
  const filePath = ensureFilePath(startPath);
  const candidates = [filePath];
  try {
    if (lstatSync(filePath).isFile()) {
      candidates.push(dirname(filePath));
    }
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    try {
      const requireFunc = createRequire(candidate);
      let packageRoot: string;

      try {
        // 1. Try direct resolution
        const packageJsonPath = requireFunc.resolve(`${packageName}/package.json`);
        packageRoot = dirname(packageJsonPath);
      } catch {
        if (!parentPackageName) {
          continue;
        }
        // 2. Try resolution via parent package (for nested dependencies)
        try {
          const parentJsonPath = requireFunc.resolve(`${parentPackageName}/package.json`);
          const requireParent = createRequire(parentJsonPath);
          const packageJsonPath = requireParent.resolve(`${packageName}/package.json`);
          packageRoot = dirname(packageJsonPath);
        } catch {
          continue;
        }
      }

      const fullPath = join(packageRoot, fileRelativePath);
      if (existsSync(fullPath)) {
        logger.debug({ packageName, fullPath }, "Resolved package file");
        return fullPath;
      }
    } catch (err) {
      logger.trace(
        { candidate, packageName, err },
        "Failed to resolve package file from candidate",
      );
      // try next candidate
    }
  }

  logger.debug({ packageName, startPath }, "Failed to resolve package file");
  return null;
}

/**
 * Reads the content of a file within a package.
 */
export function readPackageFile(
  startPath: string,
  packageName: string,
  fileRelativePath: string,
  parentPackageName?: string,
): string | null {
  const resolved = resolvePackageFile(startPath, packageName, fileRelativePath, parentPackageName);
  if (!resolved) {
    return null;
  }
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}
