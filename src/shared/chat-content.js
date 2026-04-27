export function coerceChatContentText(value) {
    if (typeof value === "string") {
        return value;
    }
    if (value == null) {
        return "";
    }
    if (typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint" ||
        typeof value === "symbol") {
        return String(value);
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value) ?? "";
        }
        catch {
            return "";
        }
    }
    return "";
}
export function extractTextFromChatContent(content, opts) {
    const normalizeText = opts?.normalizeText ?? ((text) => text.replace(/\s+/g, " ").trim());
    const joinWith = opts?.joinWith ?? " ";
    const sanitize = (text) => {
        const raw = coerceChatContentText(text);
        const sanitized = opts?.sanitizeText ? opts.sanitizeText(raw) : raw;
        return coerceChatContentText(sanitized);
    };
    const normalize = (text) => coerceChatContentText(normalizeText(coerceChatContentText(text)));
    if (typeof content === "string") {
        const value = sanitize(content);
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
        const value = sanitize(text);
        if (value.trim()) {
            chunks.push(value);
        }
    }
    const joined = normalize(chunks.join(joinWith));
    return joined ? joined : null;
}
