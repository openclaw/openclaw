import { MediaAttachmentCache, normalizeAttachments, } from "./attachments.js";
export function normalizeMediaAttachments(ctx) {
    return normalizeAttachments(ctx);
}
export function createMediaAttachmentCache(attachments, options) {
    return new MediaAttachmentCache(attachments, options);
}
