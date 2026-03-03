import fs from "node:fs";
export function resolveCacheTtlMs(params) {
    const { envValue, defaultTtlMs } = params;
    if (envValue) {
        const parsed = Number.parseInt(envValue, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }
    return defaultTtlMs;
}
export function isCacheEnabled(ttlMs) {
    return ttlMs > 0;
}
export function getFileMtimeMs(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    }
    catch {
        return undefined;
    }
}
