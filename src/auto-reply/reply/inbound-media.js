import { normalizeOptionalString } from "../../shared/string-coerce.js";
function hasNormalizedStringEntry(values) {
    return Array.isArray(values) && values.some((value) => normalizeOptionalString(value));
}
export function hasInboundMedia(ctx) {
    return Boolean(ctx.StickerMediaIncluded ||
        ctx.Sticker ||
        normalizeOptionalString(ctx.MediaPath) ||
        normalizeOptionalString(ctx.MediaUrl) ||
        hasNormalizedStringEntry(ctx.MediaPaths) ||
        hasNormalizedStringEntry(ctx.MediaUrls) ||
        (Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length > 0));
}
