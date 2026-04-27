import fs from "node:fs/promises";
import path from "node:path";
import { SafeOpenError, openFileWithinRoot } from "../infra/fs-safe.js";
export function normalizeUrlPath(rawPath) {
    const decoded = decodeURIComponent(rawPath || "/");
    const normalized = path.posix.normalize(decoded);
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
export async function resolveFileWithinRoot(rootReal, urlPath) {
    const normalized = normalizeUrlPath(urlPath);
    const rel = normalized.replace(/^\/+/, "");
    if (rel.split("/").some((p) => p === "..")) {
        return null;
    }
    const tryOpen = async (relative) => {
        try {
            return await openFileWithinRoot({ rootDir: rootReal, relativePath: relative });
        }
        catch (err) {
            if (err instanceof SafeOpenError) {
                return null;
            }
            throw err;
        }
    };
    if (normalized.endsWith("/")) {
        return await tryOpen(path.posix.join(rel, "index.html"));
    }
    const candidate = path.join(rootReal, rel);
    try {
        const st = await fs.lstat(candidate);
        if (st.isSymbolicLink()) {
            return null;
        }
        if (st.isDirectory()) {
            return await tryOpen(path.posix.join(rel, "index.html"));
        }
    }
    catch {
        // ignore
    }
    return await tryOpen(rel);
}
