import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { normalizeOptionalString, readStringValue } from "../shared/string-coerce.js";
const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
function extractComparableText(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const record = message;
    const role = readStringValue(record.role);
    const parts = [];
    const text = readStringValue(record.text);
    if (text !== undefined) {
        parts.push(text);
    }
    const content = readStringValue(record.content);
    if (content !== undefined) {
        parts.push(content);
    }
    else if (Array.isArray(record.content)) {
        for (const block of record.content) {
            if (block && typeof block === "object" && "text" in block) {
                const blockText = readStringValue(block.text);
                if (blockText !== undefined) {
                    parts.push(blockText);
                }
            }
        }
    }
    if (parts.length === 0) {
        return undefined;
    }
    const joined = parts.join("\n").trim();
    if (!joined) {
        return undefined;
    }
    const visible = role === "user" ? stripInboundMetadata(joined) : joined;
    const normalized = visible.replace(/\s+/g, " ").trim();
    return normalized || undefined;
}
function resolveFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function resolveComparableTimestamp(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    return resolveFiniteNumber(message.timestamp);
}
function resolveComparableRole(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    return readStringValue(message.role);
}
function resolveImportedExternalId(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const meta = "__openclaw" in message &&
        message.__openclaw &&
        typeof message.__openclaw === "object"
        ? (message.__openclaw ?? {})
        : undefined;
    return normalizeOptionalString(meta?.externalId);
}
function isEquivalentImportedMessage(existing, imported) {
    const importedExternalId = resolveImportedExternalId(imported);
    if (importedExternalId && resolveImportedExternalId(existing) === importedExternalId) {
        return true;
    }
    const existingRole = resolveComparableRole(existing);
    const importedRole = resolveComparableRole(imported);
    if (!existingRole || existingRole !== importedRole) {
        return false;
    }
    const existingText = extractComparableText(existing);
    const importedText = extractComparableText(imported);
    if (!existingText || !importedText || existingText !== importedText) {
        return false;
    }
    const existingTimestamp = resolveComparableTimestamp(existing);
    const importedTimestamp = resolveComparableTimestamp(imported);
    if (existingTimestamp === undefined || importedTimestamp === undefined) {
        return true;
    }
    return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS;
}
function compareHistoryMessages(a, b) {
    const aTimestamp = resolveComparableTimestamp(a.message);
    const bTimestamp = resolveComparableTimestamp(b.message);
    if (aTimestamp !== undefined && bTimestamp !== undefined && aTimestamp !== bTimestamp) {
        return aTimestamp - bTimestamp;
    }
    if (aTimestamp !== undefined && bTimestamp === undefined) {
        return -1;
    }
    if (aTimestamp === undefined && bTimestamp !== undefined) {
        return 1;
    }
    return a.order - b.order;
}
export function mergeImportedChatHistoryMessages(params) {
    if (params.importedMessages.length === 0) {
        return params.localMessages;
    }
    const merged = params.localMessages.map((message, index) => ({ message, order: index }));
    let nextOrder = merged.length;
    for (const imported of params.importedMessages) {
        if (merged.some((existing) => isEquivalentImportedMessage(existing.message, imported))) {
            continue;
        }
        merged.push({ message: imported, order: nextOrder });
        nextOrder += 1;
    }
    merged.sort(compareHistoryMessages);
    return merged.map((entry) => entry.message);
}
