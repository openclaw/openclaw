import fs from "node:fs/promises";
import path from "node:path";
export const CANONICAL_ROOT_MEMORY_FILENAME = "MEMORY.md";
export const LEGACY_ROOT_MEMORY_FILENAME = "memory.md";
export const ROOT_MEMORY_REPAIR_RELATIVE_DIR = ".openclaw-repair/root-memory";
export function resolveCanonicalRootMemoryPath(workspaceDir) {
    return path.join(workspaceDir, CANONICAL_ROOT_MEMORY_FILENAME);
}
export function resolveLegacyRootMemoryPath(workspaceDir) {
    return path.join(workspaceDir, LEGACY_ROOT_MEMORY_FILENAME);
}
export function resolveRootMemoryRepairDir(workspaceDir) {
    return path.join(workspaceDir, ".openclaw-repair", "root-memory");
}
export function normalizeWorkspaceRelativePath(value) {
    return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
export async function exactWorkspaceEntryExists(dir, name) {
    try {
        const entries = await fs.readdir(dir);
        return entries.includes(name);
    }
    catch {
        return false;
    }
}
export async function resolveCanonicalRootMemoryFile(workspaceDir) {
    try {
        const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === CANONICAL_ROOT_MEMORY_FILENAME &&
                entry.isFile() &&
                !entry.isSymbolicLink()) {
                return path.join(workspaceDir, entry.name);
            }
        }
    }
    catch { }
    return null;
}
export function shouldSkipRootMemoryAuxiliaryPath(params) {
    const relative = path.relative(params.workspaceDir, params.absPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return false;
    }
    const normalized = normalizeWorkspaceRelativePath(relative);
    return (normalized === LEGACY_ROOT_MEMORY_FILENAME ||
        normalized === ROOT_MEMORY_REPAIR_RELATIVE_DIR ||
        normalized.startsWith(`${ROOT_MEMORY_REPAIR_RELATIVE_DIR}/`));
}
