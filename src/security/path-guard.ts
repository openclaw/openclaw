import fs from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";

export class PathGuardError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PathGuardError";
    }
}

/**
 * Checks if a path is inside another path.
 */
function isPathInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && relative !== "";
}

/**
 * Resolves a path to its real canonical location, even if the file doesn't exist yet.
 * This is crucial for checking if a new file would be created inside a symlinked directory.
 */
async function resolveRealPathStrict(targetPath: string): Promise<string> {
    const absolutePath = path.resolve(targetPath);
    try {
        return await fs.realpath(absolutePath);
    } catch (err: any) {
        if (err.code === "ENOENT") {
            // For non-existent files, we must resolve the real path of the nearest existing parent.
            // This prevents escapes via a symlinked parent directory.
            let current = absolutePath;
            let suffix = "";
            while (current !== path.parse(current).root) {
                try {
                    const realParent = await fs.realpath(current);
                    return path.join(realParent, suffix);
                } catch (e: any) {
                    if (e.code === "ENOENT") {
                        suffix = path.join(path.basename(current), suffix);
                        current = path.dirname(current);
                        continue;
                    }
                    throw e;
                }
            }
            return absolutePath; // Fallback to root if nothing exists
        }
        throw err;
    }
}

/**
 * Validates a requested path against filesystem policies.
 * Prevents path traversal, symlink escapes, and enforces allowed/deny lists.
 */
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

    // 1. Workspace lock
    if (policy.workspaceOnly && !isPathInside(realWorkspaceRoot, realPath)) {
        throw new PathGuardError(
            `PathGuard security violation: Access to path "${requestedPath}" (resolved to "${realPath}") is outside the workspace root "${realWorkspaceRoot}".`,
        );
    }

    // Helper to check if a path matches a policy entry (literal or glob)
    const matchesEntry = (p: string, entry: string) => {
        // If it's an absolute path, we check directly
        if (path.isAbsolute(entry)) {
            return realPath === entry || isPathInside(entry, realPath);
        }
        // Otherwise, we treat it as workspace-relative
        const absoluteEntry = path.join(realWorkspaceRoot, entry);

        // Check for glob patterns
        if (entry.includes("*") || entry.includes("?") || entry.includes("[")) {
            // Use minimatch for glob matching against the relative path from workspace root
            const relativeToWorkspace = path.relative(realWorkspaceRoot, realPath);
            return minimatch(relativeToWorkspace, entry, { dot: true });
        }

        return realPath === absoluteEntry || isPathInside(absoluteEntry, realPath);
    };

    // 2. Deny list (takes precedence)
    if (policy.denyPaths && policy.denyPaths.length > 0) {
        for (const denyEntry of policy.denyPaths) {
            if (matchesEntry(realPath, denyEntry)) {
                throw new PathGuardError(
                    `PathGuard security violation: Access to path "${requestedPath}" is explicitly denied by pattern "${denyEntry}".`,
                );
            }
        }
    }

    // 3. Allow list
    if (policy.allowedPaths && policy.allowedPaths.length > 0) {
        let allowed = false;
        for (const allowEntry of policy.allowedPaths) {
            if (matchesEntry(realPath, allowEntry)) {
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
