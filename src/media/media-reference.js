import path from "node:path";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolveUserPath } from "../utils.js";
import { getMediaDir, resolveMediaBufferPath } from "./store.js";
export class MediaReferenceError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "MediaReferenceError";
    }
}
export function normalizeMediaReferenceSource(source) {
    const trimmed = source.trim();
    if (/^media:\/\//i.test(trimmed)) {
        return trimmed;
    }
    return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}
export function classifyMediaReferenceSource(source, options) {
    const allowDataUrl = options?.allowDataUrl ?? true;
    const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
    const isFileUrl = /^file:/i.test(source);
    const isHttpUrl = /^https?:\/\//i.test(source);
    const isDataUrl = /^data:/i.test(source);
    const isMediaStoreUrl = /^media:\/\//i.test(source);
    const hasUnsupportedScheme = hasScheme &&
        !looksLikeWindowsDrivePath &&
        !isFileUrl &&
        !isHttpUrl &&
        !isMediaStoreUrl &&
        !(allowDataUrl && isDataUrl);
    return {
        hasScheme,
        hasUnsupportedScheme,
        isDataUrl,
        isFileUrl,
        isHttpUrl,
        isMediaStoreUrl,
        looksLikeWindowsDrivePath,
    };
}
function maybeLocalPathFromSource(source) {
    if (/^file:/i.test(source)) {
        try {
            return safeFileURLToPath(source);
        }
        catch {
            return null;
        }
    }
    if (source.startsWith("~")) {
        return resolveUserPath(source);
    }
    if (path.isAbsolute(source)) {
        return source;
    }
    return null;
}
async function resolveInboundMediaUri(normalizedSource) {
    if (!/^media:\/\//i.test(normalizedSource)) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(normalizedSource);
    }
    catch (err) {
        throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
            cause: err,
        });
    }
    if (parsed.hostname !== "inbound") {
        throw new MediaReferenceError("path-not-allowed", `Unsupported media URI location: ${parsed.hostname || "(missing)"}`);
    }
    let id;
    try {
        id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    }
    catch (err) {
        throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
            cause: err,
        });
    }
    if (!id || id.includes("/") || id.includes("\\")) {
        throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
    }
    return {
        id,
        normalizedSource,
        physicalPath: await resolveInboundMediaPath(id, normalizedSource),
        sourceType: "uri",
    };
}
export async function resolveInboundMediaReference(source) {
    const normalizedSource = normalizeMediaReferenceSource(source);
    if (!normalizedSource) {
        return null;
    }
    const uriSource = await resolveInboundMediaUri(normalizedSource);
    if (uriSource) {
        return uriSource;
    }
    const localPath = maybeLocalPathFromSource(normalizedSource);
    if (!localPath) {
        return null;
    }
    const inboundDir = path.resolve(getMediaDir(), "inbound");
    const resolvedPath = path.resolve(localPath);
    const rel = path.relative(inboundDir, resolvedPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
        return null;
    }
    return {
        id: rel,
        normalizedSource,
        physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
        sourceType: "path",
    };
}
export async function resolveMediaReferenceLocalPath(source) {
    const normalizedSource = normalizeMediaReferenceSource(source);
    return (await resolveInboundMediaReference(normalizedSource))?.physicalPath ?? normalizedSource;
}
async function resolveInboundMediaPath(id, source) {
    try {
        return await resolveMediaBufferPath(id, "inbound");
    }
    catch (err) {
        throw new MediaReferenceError("invalid-path", err instanceof Error ? err.message : `Invalid media reference: ${source}`, { cause: err });
    }
}
