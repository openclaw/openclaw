import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia } from "./web-media.js";
export async function resolveOutboundAttachmentFromUrl(mediaUrl, maxBytes, options) {
    const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({
        maxBytes,
        mediaAccess: options?.mediaAccess,
        mediaLocalRoots: options?.localRoots,
        mediaReadFile: options?.readFile,
    }));
    const saved = await saveMediaBuffer(media.buffer, media.contentType ?? undefined, "outbound", maxBytes, media.fileName);
    return { path: saved.path, contentType: saved.contentType };
}
