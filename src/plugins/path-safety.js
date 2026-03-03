import fs from "node:fs";
import { isPathInside as isBoundaryPathInside } from "../infra/path-guards.js";
export function isPathInside(baseDir, targetPath) {
    return isBoundaryPathInside(baseDir, targetPath);
}
export function safeRealpathSync(targetPath, cache) {
    const cached = cache?.get(targetPath);
    if (cached) {
        return cached;
    }
    try {
        const resolved = fs.realpathSync(targetPath);
        cache?.set(targetPath, resolved);
        return resolved;
    }
    catch {
        return null;
    }
}
export function safeStatSync(targetPath) {
    try {
        return fs.statSync(targetPath);
    }
    catch {
        return null;
    }
}
export function formatPosixMode(mode) {
    return (mode & 0o777).toString(8).padStart(3, "0");
}
