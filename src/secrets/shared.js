import fs from "node:fs";
import path from "node:path";
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
export function parseEnvValue(raw) {
    const trimmed = raw.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
export function normalizePositiveInt(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(1, Math.floor(value));
    }
    return Math.max(1, Math.floor(fallback));
}
export function ensureDirForFile(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}
export function writeJsonFileSecure(pathname, value) {
    ensureDirForFile(pathname);
    fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.chmodSync(pathname, 0o600);
}
export function readTextFileIfExists(pathname) {
    if (!fs.existsSync(pathname)) {
        return null;
    }
    return fs.readFileSync(pathname, "utf8");
}
export function writeTextFileAtomic(pathname, value, mode = 0o600) {
    ensureDirForFile(pathname);
    const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, value, "utf8");
    fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, pathname);
}
