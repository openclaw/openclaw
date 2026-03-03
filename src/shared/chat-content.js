export function extractTextFromChatContent(content, opts) {
    const normalize = opts?.normalizeText ?? ((text) => text.replace(/\s+/g, " ").trim());
    const joinWith = opts?.joinWith ?? " ";
    if (typeof content === "string") {
        const value = opts?.sanitizeText ? opts.sanitizeText(content) : content;
        const normalized = normalize(value);
        return normalized ? normalized : null;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    const chunks = [];
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        if (block.type !== "text") {
            continue;
        }
        const text = block.text;
        if (typeof text !== "string") {
            continue;
        }
        const value = opts?.sanitizeText ? opts.sanitizeText(text) : text;
        if (value.trim()) {
            chunks.push(value);
        }
    }
    const joined = normalize(chunks.join(joinWith));
    return joined ? joined : null;
}
