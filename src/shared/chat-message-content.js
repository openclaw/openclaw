import { readStringValue } from "./string-coerce.js";
export function extractFirstTextBlock(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const content = message.content;
    const inline = readStringValue(content);
    if (inline !== undefined) {
        return inline;
    }
    if (!Array.isArray(content) || content.length === 0) {
        return undefined;
    }
    const first = content[0];
    if (!first || typeof first !== "object") {
        return undefined;
    }
    return readStringValue(first.text);
}
export function normalizeAssistantPhase(value) {
    return value === "commentary" || value === "final_answer" ? value : undefined;
}
export function parseAssistantTextSignature(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }
    if (!value.startsWith("{")) {
        return { id: value };
    }
    try {
        const parsed = JSON.parse(value);
        if (parsed.v !== 1) {
            return null;
        }
        return {
            ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
            ...(normalizeAssistantPhase(parsed.phase)
                ? { phase: normalizeAssistantPhase(parsed.phase) }
                : {}),
        };
    }
    catch {
        return null;
    }
}
export function encodeAssistantTextSignature(params) {
    return JSON.stringify({
        v: 1,
        id: params.id,
        ...(params.phase ? { phase: params.phase } : {}),
    });
}
export function resolveAssistantMessagePhase(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const entry = message;
    const directPhase = normalizeAssistantPhase(entry.phase);
    if (directPhase) {
        return directPhase;
    }
    if (!Array.isArray(entry.content)) {
        return undefined;
    }
    const explicitPhases = new Set();
    for (const block of entry.content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const record = block;
        if (record.type !== "text") {
            continue;
        }
        const phase = parseAssistantTextSignature(record.textSignature)?.phase;
        if (phase) {
            explicitPhases.add(phase);
        }
    }
    return explicitPhases.size === 1 ? [...explicitPhases][0] : undefined;
}
export function extractAssistantTextForPhase(message, options) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const entry = message;
    const messagePhase = normalizeAssistantPhase(entry.phase);
    const phase = options?.phase;
    const shouldIncludeContent = (resolvedPhase) => {
        if (phase) {
            return resolvedPhase === phase;
        }
        return resolvedPhase === undefined;
    };
    const sanitizeText = options?.sanitizeText;
    const joinWith = options?.joinWith ?? "\n";
    const sanitizeBlockText = (text) => (sanitizeText ? sanitizeText(text) : text);
    const normalizeJoinedText = (text) => {
        const normalized = text.trim();
        return normalized || undefined;
    };
    if (typeof entry.text === "string") {
        if (!shouldIncludeContent(messagePhase)) {
            return undefined;
        }
        return normalizeJoinedText(sanitizeBlockText(entry.text));
    }
    if (typeof entry.content === "string") {
        if (!shouldIncludeContent(messagePhase)) {
            return undefined;
        }
        return normalizeJoinedText(sanitizeBlockText(entry.content));
    }
    if (!Array.isArray(entry.content)) {
        return undefined;
    }
    const hasExplicitPhasedTextBlocks = entry.content.some((block) => {
        if (!block || typeof block !== "object") {
            return false;
        }
        const record = block;
        if (record.type !== "text") {
            return false;
        }
        return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
    });
    // Once explicit phased blocks exist, unphased extraction should not revive
    // legacy text from the same message.
    if (!phase && hasExplicitPhasedTextBlocks) {
        return undefined;
    }
    const parts = entry.content
        .map((block) => {
        if (!block || typeof block !== "object") {
            return null;
        }
        const record = block;
        if (record.type !== "text" || typeof record.text !== "string") {
            return null;
        }
        const signature = parseAssistantTextSignature(record.textSignature);
        const resolvedPhase = signature?.phase ?? (hasExplicitPhasedTextBlocks ? undefined : messagePhase);
        if (!shouldIncludeContent(resolvedPhase)) {
            return null;
        }
        const sanitized = sanitizeBlockText(record.text);
        return sanitized.trim() ? sanitized : null;
    })
        .filter((value) => typeof value === "string");
    if (parts.length === 0) {
        return undefined;
    }
    return normalizeJoinedText(parts.join(joinWith));
}
export function extractAssistantVisibleText(message) {
    const finalAnswerText = extractAssistantTextForPhase(message, { phase: "final_answer" });
    if (finalAnswerText) {
        return finalAnswerText;
    }
    return extractAssistantTextForPhase(message);
}
