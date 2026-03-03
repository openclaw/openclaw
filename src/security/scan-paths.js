import fs from "node:fs";
import path from "node:path";
export function isPathInside(basePath, candidatePath) {
    const base = path.resolve(basePath);
    const candidate = path.resolve(candidatePath);
    const rel = path.relative(base, candidate);
    return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
function safeRealpathSync(filePath) {
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return null;
    }
}
export function isPathInsideWithRealpath(basePath, candidatePath, opts) {
    if (!isPathInside(basePath, candidatePath)) {
        return false;
    }
    const baseReal = safeRealpathSync(basePath);
    const candidateReal = safeRealpathSync(candidatePath);
    if (!baseReal || !candidateReal) {
        return opts?.requireRealpath !== true;
    }
    return isPathInside(baseReal, candidateReal);
}
export function extensionUsesSkippedScannerPath(entry) {
    const segments = entry.split(/[\\/]+/).filter(Boolean);
    return segments.some((segment) => segment === "node_modules" ||
        (segment.startsWith(".") && segment !== "." && segment !== ".."));
}
