import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export function asRecord(value) {
    return typeof value === "object" && value !== null ? value : {};
}
export function asString(value) {
    return typeof value === "string" ? value : undefined;
}
export function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
export function resolveTempPathParts(opts) {
    const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
    if (!opts.tmpDir) {
        fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    }
    return {
        tmpDir,
        id: opts.id ?? randomUUID(),
        ext: opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`,
    };
}
