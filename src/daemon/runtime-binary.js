import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const NODE_VERSIONED_PATTERN = /^node(?:-\d+|\d+)(?:\.\d+)*(?:\.exe)?$/;
function normalizeRuntimeBasename(execPath) {
    const trimmed = execPath.trim().replace(/^["']|["']$/g, "");
    const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const basename = lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
    return normalizeLowercaseStringOrEmpty(basename);
}
export function isNodeRuntime(execPath) {
    const base = normalizeRuntimeBasename(execPath);
    return (base === "node" ||
        base === "node.exe" ||
        base === "nodejs" ||
        base === "nodejs.exe" ||
        NODE_VERSIONED_PATTERN.test(base));
}
export function isBunRuntime(execPath) {
    const base = normalizeRuntimeBasename(execPath);
    return base === "bun" || base === "bun.exe";
}
