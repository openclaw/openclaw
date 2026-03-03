import fs from "node:fs";
import path from "node:path";
// Keep defaults to OS-managed immutable bins only.
// User/package-manager bins must be opted in via tools.exec.safeBinTrustedDirs.
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];
let trustedSafeBinCache = null;
function normalizeTrustedDir(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    return path.resolve(trimmed);
}
export function normalizeTrustedSafeBinDirs(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }
    const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    return Array.from(new Set(normalized));
}
function resolveTrustedSafeBinDirs(entries) {
    const resolved = entries
        .map((entry) => normalizeTrustedDir(entry))
        .filter((entry) => Boolean(entry));
    return Array.from(new Set(resolved)).toSorted();
}
function buildTrustedSafeBinCacheKey(entries) {
    return resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("\u0001");
}
export function buildTrustedSafeBinDirs(params = {}) {
    const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
    const extraDirs = params.extraDirs ?? [];
    // Trust is explicit only. Do not derive from PATH, which is user/environment controlled.
    return new Set(resolveTrustedSafeBinDirs([
        ...normalizeTrustedSafeBinDirs(baseDirs),
        ...normalizeTrustedSafeBinDirs(extraDirs),
    ]));
}
export function getTrustedSafeBinDirs(params = {}) {
    const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
    const extraDirs = params.extraDirs ?? [];
    const key = buildTrustedSafeBinCacheKey([...baseDirs, ...extraDirs]);
    if (!params.refresh && trustedSafeBinCache?.key === key) {
        return trustedSafeBinCache.dirs;
    }
    const dirs = buildTrustedSafeBinDirs({
        baseDirs,
        extraDirs,
    });
    trustedSafeBinCache = { key, dirs };
    return dirs;
}
export function isTrustedSafeBinPath(params) {
    const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
    const resolvedDir = path.dirname(path.resolve(params.resolvedPath));
    return trustedDirs.has(resolvedDir);
}
export function listWritableExplicitTrustedSafeBinDirs(entries) {
    if (process.platform === "win32") {
        return [];
    }
    const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries));
    const hits = [];
    for (const dir of resolved) {
        let stat;
        try {
            stat = fs.statSync(dir);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory()) {
            continue;
        }
        const mode = stat.mode & 0o777;
        const groupWritable = (mode & 0o020) !== 0;
        const worldWritable = (mode & 0o002) !== 0;
        if (!groupWritable && !worldWritable) {
            continue;
        }
        hits.push({ dir, groupWritable, worldWritable });
    }
    return hits;
}
