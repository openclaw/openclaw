import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveRealPathStrict(targetPath: string): Promise<string> {
  const absolutePath = path.resolve(targetPath);
  try {
    return await fs.realpath(absolutePath);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // For non-existent files, resolve nearest existing parent to prevent
      // symlink escapes via not-yet-created paths.
      let current = absolutePath;
      let suffix = "";
      while (current !== path.parse(current).root) {
        try {
          const realParent = await fs.realpath(current);
          return path.join(realParent, suffix);
        } catch (innerError: unknown) {
          const innerErr = innerError as NodeJS.ErrnoException;
          if (innerErr.code === "ENOENT") {
            suffix = path.join(path.basename(current), suffix);
            current = path.dirname(current);
            continue;
          }
          throw innerError;
        }
      }
      return absolutePath;
    }
    throw error;
  }
}

export async function checkPathGuardStrict(
  requestedPath: string,
  policy: {
    workspaceOnly?: boolean;
    allowedPaths?: string[];
    denyPaths?: string[];
  },
  workspaceRoot: string,
): Promise<string> {
  const realWorkspaceRoot = await fs.realpath(path.resolve(workspaceRoot));
  const realPath = await resolveRealPathStrict(requestedPath);

  // 1) Workspace lock
  if (policy.workspaceOnly && !isPathInside(realWorkspaceRoot, realPath)) {
    throw new PathGuardError(
      `PathGuard security violation: Access to path "${requestedPath}" (resolved to "${realPath}") is outside the workspace root "${realWorkspaceRoot}".`,
    );
  }

  // Helper to check if a path matches a policy entry (literal path or glob).
  const normalizedRealPath = toPosixPath(realPath);

  const matchesEntry = async (entry: string): Promise<boolean> => {
    if (path.isAbsolute(entry)) {
      const canonicalEntry = await resolveRealPathStrict(entry);
      const normalizedEntry = toPosixPath(canonicalEntry);
      return (
        normalizedRealPath === normalizedEntry || isPathInside(normalizedEntry, normalizedRealPath)
      );
    }

    const absoluteEntry = path.join(realWorkspaceRoot, entry);

    if (entry.includes("*") || entry.includes("?") || entry.includes("[")) {
      const relativeToWorkspace = toPosixPath(path.relative(realWorkspaceRoot, realPath));
      // Relative policy entries are workspace-anchored and must never match
      // targets outside workspace.
      if (relativeToWorkspace.startsWith("../") || relativeToWorkspace === "..") {
        return false;
      }
      if (path.isAbsolute(relativeToWorkspace)) {
        return false;
      }
      const normalizedPattern = toPosixPath(entry);
      return minimatch(relativeToWorkspace, normalizedPattern, { dot: true });
    }

    const normalizedAbsoluteEntry = toPosixPath(absoluteEntry);
    return (
      normalizedRealPath === normalizedAbsoluteEntry ||
      isPathInside(normalizedAbsoluteEntry, normalizedRealPath)
    );
  };

  // 2) Deny list (takes precedence)
  if (policy.denyPaths && policy.denyPaths.length > 0) {
    for (const denyEntry of policy.denyPaths) {
      if (await matchesEntry(denyEntry)) {
        throw new PathGuardError(
          `PathGuard security violation: Access to path "${requestedPath}" is explicitly denied by pattern "${denyEntry}".`,
        );
      }
    }
  }

  // 3) Allow list
  if (policy.allowedPaths && policy.allowedPaths.length > 0) {
    let allowed = false;
    for (const allowEntry of policy.allowedPaths) {
      if (await matchesEntry(allowEntry)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      throw new PathGuardError(
        `PathGuard security violation: Access to path "${requestedPath}" is not in the allowedPaths list.`,
      );
    }
  }

  return realPath;
}
