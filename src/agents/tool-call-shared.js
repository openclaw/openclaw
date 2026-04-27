import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export const TOOL_CALL_NAME_MAX_CHARS = 64;
export const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;
export const REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT = "__OPENCLAW_REDACTED__";
export const SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS = ["name", "encoding", "mimeType"];
export function normalizeAllowedToolNames(allowedToolNames) {
    if (!allowedToolNames) {
        return null;
    }
    const normalized = new Set();
    for (const name of allowedToolNames) {
        if (typeof name !== "string") {
            continue;
        }
        const trimmed = name.trim();
        if (!trimmed) {
            continue;
        }
        normalized.add(normalizeLowercaseStringOrEmpty(trimmed));
    }
    return normalized.size > 0 ? normalized : null;
}
export function isAllowedToolCallName(name, allowedToolNames) {
    if (typeof name !== "string") {
        return false;
    }
    const trimmed = name.trim();
    if (!trimmed) {
        return false;
    }
    if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) {
        return false;
    }
    if (!allowedToolNames) {
        return true;
    }
    return allowedToolNames.has(normalizeLowercaseStringOrEmpty(trimmed));
}
export function isRedactedSessionsSpawnAttachment(item) {
    if (!item || typeof item !== "object") {
        return false;
    }
    const attachment = item;
    if (attachment.content !== REDACTED_SESSIONS_SPAWN_ATTACHMENT_CONTENT) {
        return false;
    }
    for (const key of Object.keys(attachment)) {
        if (key === "content") {
            continue;
        }
        if (!SESSIONS_SPAWN_ATTACHMENT_METADATA_KEYS.includes(key)) {
            return false;
        }
        if (typeof attachment[key] !== "string" || attachment[key].trim().length === 0) {
            return false;
        }
    }
    return true;
}
export function hasUnredactedSessionsSpawnAttachments(block) {
    const rawName = typeof block.name === "string" ? block.name.trim() : "";
    if (normalizeLowercaseStringOrEmpty(rawName) !== "sessions_spawn") {
        return false;
    }
    for (const payload of [block.arguments, block.input]) {
        if (!payload || typeof payload !== "object") {
            continue;
        }
        const attachments = payload.attachments;
        if (!Array.isArray(attachments)) {
            continue;
        }
        for (const attachment of attachments) {
            if (!isRedactedSessionsSpawnAttachment(attachment)) {
                return true;
            }
        }
    }
    return false;
}
