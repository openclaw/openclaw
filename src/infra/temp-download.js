import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
export { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
function sanitizePrefix(prefix) {
    const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "tmp";
}
function sanitizeExtension(extension) {
    if (!extension) {
        return "";
    }
    const normalized = extension.startsWith(".") ? extension : `.${extension}`;
    const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "";
    const token = suffix.replace(/^[._-]+/, "");
    return token ? `.${token}` : "";
}
export function sanitizeTempFileName(fileName) {
    const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
    const normalized = base.replace(/^-+|-+$/g, "");
    return normalized || "download.bin";
}
function resolveTempRoot(tmpDir) {
    return tmpDir ?? resolvePreferredOpenClawTmpDir();
}
function isNodeErrorWithCode(err, code) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === code);
}
async function cleanupTempDir(dir) {
    try {
        await rm(dir, { recursive: true, force: true });
    }
    catch (err) {
        if (!isNodeErrorWithCode(err, "ENOENT")) {
            console.warn(`temp-path cleanup failed for ${dir}: ${String(err)}`);
        }
    }
}
export function buildRandomTempFilePath(params) {
    const prefix = sanitizePrefix(params.prefix);
    const extension = sanitizeExtension(params.extension);
    const nowCandidate = params.now;
    const now = typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
        ? Math.trunc(nowCandidate)
        : Date.now();
    const uuid = params.uuid?.trim() || crypto.randomUUID();
    return path.join(resolveTempRoot(params.tmpDir), `${prefix}-${now}-${uuid}${extension}`);
}
export async function createTempDownloadTarget(params) {
    const tempRoot = resolveTempRoot(params.tmpDir);
    const prefix = `${sanitizePrefix(params.prefix)}-`;
    const dir = await mkdtemp(path.join(tempRoot, prefix));
    return {
        dir,
        path: path.join(dir, sanitizeTempFileName(params.fileName ?? "download.bin")),
        cleanup: async () => {
            await cleanupTempDir(dir);
        },
    };
}
export async function withTempDownloadPath(params, fn) {
    const target = await createTempDownloadTarget(params);
    try {
        return await fn(target.path);
    }
    finally {
        await target.cleanup();
    }
}
