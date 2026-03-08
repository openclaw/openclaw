import fs from "node:fs/promises";
import path from "node:path";
import type { ToolFsPolicy } from "../agents/tool-fs-policy.js";
import { isPathInside } from "../infra/path-guards.js";

export class PathGuardError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PathGuardError";
    }
}

export async function checkPathGuardStrict(
    requestedPath: string,
    policy: ToolFsPolicy,
    workspaceRoot: string
): Promise<void> {
    // Always restrict to workspace if no explicit policy is provided but workspaceOnly is enabled
    const hasExplicitPolicy = (policy.allowedPaths?.length ?? 0) > 0 || (policy.denyPaths?.length ?? 0) > 0;
    if (!hasExplicitPolicy && !policy.workspaceOnly) {
        return;
    }

    // 1. Resolve to real absolute path, including symlinks.
    let realPath: string;
    try {
        realPath = await fs.realpath(path.resolve(requestedPath));
    } catch (err) {
        // If the path doesn't exist, we fall back to resolving its absolute string
        // to check if its *intended* location is blocked.
        realPath = path.resolve(requestedPath);
    }

    // 2. Resolve workspace root similarly
    let realWorkspaceRoot: string;
    try {
        realWorkspaceRoot = await fs.realpath(path.resolve(workspaceRoot));
    } catch {
        realWorkspaceRoot = path.resolve(workspaceRoot);
    }

    // Helper to resolve policy paths
    const resolvePolicyPath = async (p: string) => {
        try {
            if (path.isAbsolute(p)) {
                return await fs.realpath(path.resolve(p));
            }
            return await fs.realpath(path.resolve(realWorkspaceRoot, p));
        } catch {
            if (path.isAbsolute(p)) {
                return path.resolve(p);
            }
            return path.resolve(realWorkspaceRoot, p);
        }
    };

    // 3. Check denyPaths FIRST (takes precedence)
    if (policy.denyPaths && policy.denyPaths.length > 0) {
        for (const deny of policy.denyPaths) {
            const realDeny = await resolvePolicyPath(deny);
            if (isPathInside(realDeny, realPath) || realDeny === realPath) {
                throw new PathGuardError(`Access to ${requestedPath} is explicitly denied by policy.`);
            }
        }
    }

    // 4. Check allowedPaths
    if (policy.allowedPaths && policy.allowedPaths.length > 0) {
        let isAllowed = false;
        for (const allow of policy.allowedPaths) {
            const realAllow = await resolvePolicyPath(allow);
            if (isPathInside(realAllow, realPath) || realAllow === realPath) {
                isAllowed = true;
                break;
            }
        }
        if (!isAllowed) {
            throw new PathGuardError(`Access to ${requestedPath} is not in allowed paths policy.`);
        }
    } else if (policy.workspaceOnly) {
        // 5. Fallback to workspaceOnly
        if (!isPathInside(realWorkspaceRoot, realPath) && realWorkspaceRoot !== realPath) {
            throw new PathGuardError(`Access to ${requestedPath} is outside workspace root.`);
        }
    }
}
