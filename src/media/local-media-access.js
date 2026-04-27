import fs from "node:fs/promises";
import path from "node:path";
import { assertNoWindowsNetworkPath } from "../infra/local-file-access.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { resolveInboundMediaReference } from "./media-reference.js";
export class LocalMediaAccessError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "LocalMediaAccessError";
    }
}
export function getDefaultLocalRoots() {
    return getDefaultMediaLocalRoots();
}
export async function assertLocalMediaAllowed(mediaPath, localRoots) {
    if (localRoots === "any") {
        return;
    }
    const inboundReference = await resolveInboundMediaReference(mediaPath).catch(() => null);
    if (inboundReference) {
        return;
    }
    try {
        assertNoWindowsNetworkPath(mediaPath, "Local media path");
    }
    catch (err) {
        throw new LocalMediaAccessError("network-path-not-allowed", err.message, {
            cause: err,
        });
    }
    const roots = localRoots ?? getDefaultLocalRoots();
    let resolved;
    try {
        resolved = await fs.realpath(mediaPath);
    }
    catch {
        resolved = path.resolve(mediaPath);
    }
    if (localRoots === undefined) {
        const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
        if (workspaceRoot) {
            const stateDir = path.dirname(workspaceRoot);
            const rel = path.relative(stateDir, resolved);
            if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
                const firstSegment = rel.split(path.sep)[0] ?? "";
                if (firstSegment.startsWith("workspace-")) {
                    throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
                }
            }
        }
    }
    for (const root of roots) {
        let resolvedRoot;
        try {
            resolvedRoot = await fs.realpath(root);
        }
        catch {
            resolvedRoot = path.resolve(root);
        }
        if (resolvedRoot === path.parse(resolvedRoot).root) {
            throw new LocalMediaAccessError("invalid-root", `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`);
        }
        if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
            return;
        }
    }
    throw new LocalMediaAccessError("path-not-allowed", `Local media path is not under an allowed directory: ${mediaPath}`);
}
