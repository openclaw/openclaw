const OBJECT_REPLACEMENT = "\uFFFC";
function isValidMention(mention) {
    if (!mention) {
        return false;
    }
    if (!(mention.uuid || mention.number)) {
        return false;
    }
    if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
        return false;
    }
    if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
        return false;
    }
    return mention.length > 0;
}
function clampBounds(start, length, textLength) {
    const safeStart = Math.max(0, Math.trunc(start));
    const safeLength = Math.max(0, Math.trunc(length));
    const safeEnd = Math.min(textLength, safeStart + safeLength);
    return { start: safeStart, end: safeEnd };
}
export function renderSignalMentions(message, mentions) {
    if (!message || !mentions?.length) {
        return message;
    }
    let normalized = message;
    const candidates = mentions.filter(isValidMention).toSorted((a, b) => b.start - a.start);
    for (const mention of candidates) {
        const identifier = mention.uuid ?? mention.number;
        if (!identifier) {
            continue;
        }
        const { start, end } = clampBounds(mention.start, mention.length, normalized.length);
        if (start >= end) {
            continue;
        }
        const slice = normalized.slice(start, end);
        if (!slice.includes(OBJECT_REPLACEMENT)) {
            continue;
        }
        normalized = normalized.slice(0, start) + `@${identifier}` + normalized.slice(end);
    }
    return normalized;
}
