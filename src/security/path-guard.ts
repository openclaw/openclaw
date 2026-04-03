import fs from "node:fs/promises";
import path from "node:path";
import { minimatch, Minimatch } from "minimatch";

export type PathGuardViolationRule = "workspaceOnly" | "denyPaths" | "allowedPaths";

export class PathGuardError extends Error {
  code = "PATH_GUARD_DENIED" as const;
  requestedPath: string;
  resolvedPath?: string;
  workspaceRoot?: string;
  violatedRule: PathGuardViolationRule;
  matchedEntry?: string;

  constructor(args: {
    message: string;
    requestedPath: string;
    resolvedPath?: string;
    workspaceRoot?: string;
    violatedRule: PathGuardViolationRule;
    matchedEntry?: string;
  }) {
    super(args.message);
    this.name = "PathGuardError";
    this.requestedPath = args.requestedPath;
    this.resolvedPath = args.resolvedPath;
    this.workspaceRoot = args.workspaceRoot;
    this.violatedRule = args.violatedRule;
    this.matchedEntry = args.matchedEntry;
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
    throw new PathGuardError({
      message: `PathGuard security violation: Access to path "${requestedPath}" (resolved to "${realPath}") is outside the workspace root "${realWorkspaceRoot}".`,
      requestedPath,
      resolvedPath: realPath,
      workspaceRoot: realWorkspaceRoot,
      violatedRule: "workspaceOnly",
    });
  }

  // Helper to check if a path matches a policy entry (literal path or glob).
  const normalizedRealPath = toPosixPath(realPath);

  const matchesEntry = async (entry: string): Promise<boolean> => {
    if (path.isAbsolute(entry)) {
      const normalizedEntryPattern = toPosixPath(entry);
      const hasGlobMagic = new Minimatch(normalizedEntryPattern, {
        dot: true,
        magicalBraces: true,
      }).hasMagic();

      if (hasGlobMagic) {
        // Absolute glob entries match the canonicalized real path.
        // Canonicalize the non-glob prefix so symlink-alias patterns still match canonical targets.
        // Example: /workspace/link/**/*.txt should still match when link -> /mnt/data.
        // Split at the first glob-magic character supported by minimatch (including braces/extglobs).
        // This avoids trying to realpath a prefix that already contains magic.
        const firstMagic = (() => {
          const candidates = [
            normalizedEntryPattern.indexOf("*"),
            normalizedEntryPattern.indexOf("?"),
            normalizedEntryPattern.indexOf("["),
            normalizedEntryPattern.indexOf("]"),
            normalizedEntryPattern.indexOf("{"),
            normalizedEntryPattern.indexOf("}"),
            normalizedEntryPattern.indexOf("("),
            normalizedEntryPattern.indexOf(")"),
            normalizedEntryPattern.indexOf("!"),
            normalizedEntryPattern.indexOf("+"),
            normalizedEntryPattern.indexOf("@"),
          ].filter((v) => v >= 0);
          return candidates.length ? Math.min(...candidates) : -1;
        })();
        // Canonicalize a *directory* prefix, not a partial path segment.
        // If magic appears mid-segment (e.g. /dir[12]/...), splitting at firstMagic would produce
        // prefix=/dir and rest=[12]/..., and inserting '/' changes semantics. Instead, rewrite from
        // the last '/' before firstMagic.
        const splitIndex = firstMagic >= 0 ? normalizedEntryPattern.lastIndexOf("/", firstMagic) : -1;
        const dirPrefix = splitIndex > 0 ? normalizedEntryPattern.slice(0, splitIndex) : "/";
        const remainder = splitIndex >= 0 ? normalizedEntryPattern.slice(splitIndex) : normalizedEntryPattern;
        try {
          const canonicalDirPrefix = toPosixPath(await resolveRealPathStrict(dirPrefix));

          // Normalize slash joining so root-prefixed patterns don't become //**/*.pem.
          const rewrittenPattern =
            canonicalDirPrefix.endsWith("/") && remainder.startsWith("/")
              ? `${canonicalDirPrefix}${remainder.slice(1)}`
              : canonicalDirPrefix.endsWith("/") || remainder.startsWith("/")
                ? `${canonicalDirPrefix}${remainder}`
                : `${canonicalDirPrefix}/${remainder}`;

          return minimatch(normalizedRealPath, rewrittenPattern, {
            dot: true,
            magicalBraces: true,
          });
        } catch {
          // Fallback: if prefix cannot be canonicalized (non-existent), match against the raw pattern.
          return minimatch(normalizedRealPath, normalizedEntryPattern, {
            dot: true,
            magicalBraces: true,
          });
        }
      }

      const canonicalEntry = await resolveRealPathStrict(entry);
      const normalizedEntry = toPosixPath(canonicalEntry);
      return (
        normalizedRealPath === normalizedEntry || isPathInside(normalizedEntry, normalizedRealPath)
      );
    }

    const absoluteEntry = path.join(realWorkspaceRoot, entry);
    const normalizedWorkspaceRoot = toPosixPath(realWorkspaceRoot);
    const normalizedAbsoluteEntry = toPosixPath(absoluteEntry);

    // Relative policy entries are workspace-anchored and must never escape it.
    if (!isPathInside(normalizedWorkspaceRoot, normalizedAbsoluteEntry)) {
      return false;
    }

    // Canonicalize relative literal entries into realpath-space.
    // Otherwise a policy like denyPaths:["vendor"] could be bypassed if "vendor" is a symlink
    // that resolves outside workspace, because requested targets are matched in realpath-space.
    const canonicalAbsoluteEntry = await resolveRealPathStrict(absoluteEntry);
    const normalizedCanonicalAbsoluteEntry = toPosixPath(canonicalAbsoluteEntry);

    // Relative policy entries are workspace-anchored by intent.
    // If the canonicalized entry escapes the workspace (e.g. entry points at a symlinked dir outside),
    // it must NOT match outside-workspace targets.
    if (!isPathInside(normalizedWorkspaceRoot, normalizedCanonicalAbsoluteEntry)) {
      return false;
    }

    const normalizedPattern = toPosixPath(entry);
    const hasGlobMagic = new Minimatch(normalizedPattern, {
      dot: true,
      magicalBraces: true,
    }).hasMagic();

    if (hasGlobMagic) {
      const relativeToWorkspace = toPosixPath(path.relative(realWorkspaceRoot, realPath));
      // Relative policy entries are workspace-anchored and must never match
      // targets outside workspace.
      if (relativeToWorkspace.startsWith("../") || relativeToWorkspace === "..") {
        return false;
      }
      if (path.isAbsolute(relativeToWorkspace)) {
        return false;
      }
      return minimatch(relativeToWorkspace, normalizedPattern, { dot: true, magicalBraces: true });
    }
    return (
      normalizedRealPath === normalizedCanonicalAbsoluteEntry ||
      isPathInside(normalizedCanonicalAbsoluteEntry, normalizedRealPath)
    );
  };

  // 2) Deny list (takes precedence)
  if (policy.denyPaths && policy.denyPaths.length > 0) {
    for (const denyEntry of policy.denyPaths) {
      if (await matchesEntry(denyEntry)) {
        throw new PathGuardError({
          message: `PathGuard security violation: Access to path "${requestedPath}" is explicitly denied by pattern "${denyEntry}".`,
          requestedPath,
          resolvedPath: realPath,
          workspaceRoot: realWorkspaceRoot,
          violatedRule: "denyPaths",
          matchedEntry: denyEntry,
        });
      }
    }
  }

  // 3) Allow list
  // Treat allowedPaths: [] as an explicit deny-all.
  if (policy.allowedPaths !== undefined) {
    let allowed = false;
    for (const allowEntry of policy.allowedPaths) {
      if (await matchesEntry(allowEntry)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      throw new PathGuardError({
        message: `PathGuard security violation: Access to path "${requestedPath}" is not in the allowedPaths list.`,
        requestedPath,
        resolvedPath: realPath,
        workspaceRoot: realWorkspaceRoot,
        violatedRule: "allowedPaths",
      });
    }
  }

  return realPath;
}
