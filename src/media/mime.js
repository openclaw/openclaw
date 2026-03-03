import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { mediaKindFromMime } from "./constants.js";
// Map common mimes to preferred file extensions.
const EXT_BY_MIME = {
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/x-m4a": ".m4a",
    "audio/mp4": ".m4a",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/zip": ".zip",
    "application/gzip": ".gz",
    "application/x-tar": ".tar",
    "application/x-7z-compressed": ".7z",
    "application/vnd.rar": ".rar",
    "application/msword": ".doc",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "text/csv": ".csv",
    "text/plain": ".txt",
    "text/markdown": ".md",
};
const MIME_BY_EXT = {
    ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
    // Additional extension aliases
    ".jpeg": "image/jpeg",
    ".js": "text/javascript",
};
const AUDIO_FILE_EXTENSIONS = new Set([
    ".aac",
    ".caf",
    ".flac",
    ".m4a",
    ".mp3",
    ".oga",
    ".ogg",
    ".opus",
    ".wav",
]);
export function normalizeMimeType(mime) {
    if (!mime) {
        return undefined;
    }
    const cleaned = mime.split(";")[0]?.trim().toLowerCase();
    return cleaned || undefined;
}
async function sniffMime(buffer) {
    if (!buffer) {
        return undefined;
    }
    try {
        const type = await fileTypeFromBuffer(buffer);
        return type?.mime ?? undefined;
    }
    catch {
        return undefined;
    }
}
export function getFileExtension(filePath) {
    if (!filePath) {
        return undefined;
    }
    try {
        if (/^https?:\/\//i.test(filePath)) {
            const url = new URL(filePath);
            return path.extname(url.pathname).toLowerCase() || undefined;
        }
    }
    catch {
        // fall back to plain path parsing
    }
    const ext = path.extname(filePath).toLowerCase();
    return ext || undefined;
}
export function isAudioFileName(fileName) {
    const ext = getFileExtension(fileName);
    if (!ext) {
        return false;
    }
    return AUDIO_FILE_EXTENSIONS.has(ext);
}
export function detectMime(opts) {
    return detectMimeImpl(opts);
}
function isGenericMime(mime) {
    if (!mime) {
        return true;
    }
    const m = mime.toLowerCase();
    return m === "application/octet-stream" || m === "application/zip";
}
async function detectMimeImpl(opts) {
    const ext = getFileExtension(opts.filePath);
    const extMime = ext ? MIME_BY_EXT[ext] : undefined;
    const headerMime = normalizeMimeType(opts.headerMime);
    const sniffed = await sniffMime(opts.buffer);
    // Prefer sniffed types, but don't let generic container types override a more
    // specific extension mapping (e.g. XLSX vs ZIP).
    if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
        return sniffed;
    }
    if (extMime) {
        return extMime;
    }
    if (headerMime && !isGenericMime(headerMime)) {
        return headerMime;
    }
    if (sniffed) {
        return sniffed;
    }
    if (headerMime) {
        return headerMime;
    }
    return undefined;
}
export function extensionForMime(mime) {
    const normalized = normalizeMimeType(mime);
    if (!normalized) {
        return undefined;
    }
    return EXT_BY_MIME[normalized];
}
export function isGifMedia(opts) {
    if (opts.contentType?.toLowerCase() === "image/gif") {
        return true;
    }
    const ext = getFileExtension(opts.fileName);
    return ext === ".gif";
}
export function imageMimeFromFormat(format) {
    if (!format) {
        return undefined;
    }
    switch (format.toLowerCase()) {
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "heic":
            return "image/heic";
        case "heif":
            return "image/heif";
        case "png":
            return "image/png";
        case "webp":
            return "image/webp";
        case "gif":
            return "image/gif";
        default:
            return undefined;
    }
}
export function kindFromMime(mime) {
    return mediaKindFromMime(mime);
}
