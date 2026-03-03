import path from "node:path";
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_OPEN_CODES = new Set(["ELOOP", "EINVAL", "ENOTSUP"]);
function normalizeWindowsPathForComparison(input) {
    let normalized = path.win32.normalize(input);
    if (normalized.startsWith("\\\\?\\")) {
        normalized = normalized.slice(4);
        if (normalized.toUpperCase().startsWith("UNC\\")) {
            normalized = `\\\\${normalized.slice(4)}`;
        }
    }
    return normalized.replaceAll("/", "\\").toLowerCase();
}
export function isNodeError(value) {
    return Boolean(value && typeof value === "object" && "code" in value);
}
export function hasNodeErrorCode(value, code) {
    return isNodeError(value) && value.code === code;
}
export function isNotFoundPathError(value) {
    return isNodeError(value) && typeof value.code === "string" && NOT_FOUND_CODES.has(value.code);
}
export function isSymlinkOpenError(value) {
    return isNodeError(value) && typeof value.code === "string" && SYMLINK_OPEN_CODES.has(value.code);
}
export function isPathInside(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    if (process.platform === "win32") {
        const rootForCompare = normalizeWindowsPathForComparison(resolvedRoot);
        const targetForCompare = normalizeWindowsPathForComparison(resolvedTarget);
        const relative = path.win32.relative(rootForCompare, targetForCompare);
        return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
    }
    const relative = path.relative(resolvedRoot, resolvedTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
