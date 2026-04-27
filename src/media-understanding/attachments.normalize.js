import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import { getFileExtension, isAudioFileName, kindFromMime } from "../media/mime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
export function normalizeAttachmentPath(raw) {
    const value = normalizeOptionalString(raw);
    if (!value) {
        return undefined;
    }
    if (value.startsWith("file://")) {
        try {
            return safeFileURLToPath(value);
        }
        catch {
            return undefined;
        }
    }
    try {
        assertNoWindowsNetworkPath(value, "Attachment path");
    }
    catch {
        return undefined;
    }
    return value;
}
export function normalizeAttachments(ctx) {
    const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
    const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : undefined;
    const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : undefined;
    const resolveMime = (count, index) => {
        const typeHint = normalizeOptionalString(typesFromArray?.[index]);
        if (typeHint) {
            return typeHint;
        }
        return count === 1 ? ctx.MediaType : undefined;
    };
    if (pathsFromArray && pathsFromArray.length > 0) {
        const count = pathsFromArray.length;
        const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : undefined;
        return pathsFromArray
            .map((value, index) => ({
            path: normalizeOptionalString(value),
            url: urls?.[index] ?? ctx.MediaUrl,
            mime: resolveMime(count, index),
            index,
        }))
            .filter((entry) => Boolean(entry.path ?? normalizeOptionalString(entry.url)));
    }
    if (urlsFromArray && urlsFromArray.length > 0) {
        const count = urlsFromArray.length;
        return urlsFromArray
            .map((value, index) => ({
            path: undefined,
            url: normalizeOptionalString(value),
            mime: resolveMime(count, index),
            index,
        }))
            .filter((entry) => Boolean(entry.url));
    }
    const pathValue = normalizeOptionalString(ctx.MediaPath);
    const url = normalizeOptionalString(ctx.MediaUrl);
    if (!pathValue && !url) {
        return [];
    }
    return [
        {
            path: pathValue || undefined,
            url: url || undefined,
            mime: ctx.MediaType,
            index: 0,
        },
    ];
}
export function resolveAttachmentKind(attachment) {
    const kind = kindFromMime(attachment.mime);
    if (kind === "image" || kind === "audio" || kind === "video") {
        return kind;
    }
    const ext = getFileExtension(attachment.path ?? attachment.url);
    if (!ext) {
        return "unknown";
    }
    if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext)) {
        return "video";
    }
    if (isAudioFileName(attachment.path ?? attachment.url)) {
        return "audio";
    }
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"].includes(ext)) {
        return "image";
    }
    return "unknown";
}
export function isVideoAttachment(attachment) {
    return resolveAttachmentKind(attachment) === "video";
}
export function isAudioAttachment(attachment) {
    return resolveAttachmentKind(attachment) === "audio";
}
export function isImageAttachment(attachment) {
    return resolveAttachmentKind(attachment) === "image";
}
