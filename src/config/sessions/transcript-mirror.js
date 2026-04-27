import path from "node:path";
function stripQuery(value) {
    const noHash = value.split("#")[0] ?? value;
    return noHash.split("?")[0] ?? noHash;
}
function extractFileNameFromMediaUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const cleaned = stripQuery(trimmed);
    try {
        const parsed = new URL(cleaned);
        const base = path.basename(parsed.pathname);
        if (!base) {
            return null;
        }
        try {
            return decodeURIComponent(base);
        }
        catch {
            return base;
        }
    }
    catch {
        const base = path.basename(cleaned);
        if (!base || base === "/" || base === ".") {
            return null;
        }
        return base;
    }
}
export function resolveMirroredTranscriptText(params) {
    const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
    if (mediaUrls.length > 0) {
        const names = mediaUrls
            .map((url) => extractFileNameFromMediaUrl(url))
            .filter((name) => Boolean(name && name.trim()));
        if (names.length > 0) {
            return names.join(", ");
        }
        return "media";
    }
    const text = params.text ?? "";
    const trimmed = text.trim();
    return trimmed ? trimmed : null;
}
