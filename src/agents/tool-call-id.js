import { createHash } from "node:crypto";
import { hasUnredactedSessionsSpawnAttachments, isAllowedToolCallName, normalizeAllowedToolNames, } from "./tool-call-shared.js";
const NATIVE_ANTHROPIC_TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_]+$/;
const NATIVE_KIMI_TOOL_CALL_ID_RE = /^functions\.[A-Za-z0-9_-]+:\d+$/;
const STRICT9_LEN = 9;
const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "strict" mode: only [a-zA-Z0-9]
 * - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
 */
export function sanitizeToolCallId(id, mode = "strict") {
    if (!id || typeof id !== "string") {
        if (mode === "strict9") {
            return "defaultid";
        }
        return "defaulttoolid";
    }
    if (mode === "strict9") {
        const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
        if (alphanumericOnly.length >= STRICT9_LEN) {
            return alphanumericOnly.slice(0, STRICT9_LEN);
        }
        if (alphanumericOnly.length > 0) {
            return shortHash(alphanumericOnly, STRICT9_LEN);
        }
        return shortHash("sanitized", STRICT9_LEN);
    }
    if (isNativeKimiToolCallId(id)) {
        return id;
    }
    // Some providers require strictly alphanumeric tool call IDs.
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}
export function extractToolCallsFromAssistant(msg) {
    const content = msg.content;
    if (!Array.isArray(content)) {
        return [];
    }
    const toolCalls = [];
    for (const block of content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const rec = block;
        if (typeof rec.id !== "string" || !rec.id) {
            continue;
        }
        if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
            toolCalls.push({
                id: rec.id,
                name: typeof rec.name === "string" ? rec.name : undefined,
            });
        }
    }
    return toolCalls;
}
export function extractToolResultId(msg) {
    const toolCallId = msg.toolCallId;
    if (typeof toolCallId === "string" && toolCallId) {
        return toolCallId;
    }
    const toolUseId = msg.toolUseId;
    if (typeof toolUseId === "string" && toolUseId) {
        return toolUseId;
    }
    return null;
}
function isThinkingLikeBlock(block) {
    if (!block || typeof block !== "object") {
        return false;
    }
    const type = block.type;
    return type === "thinking" || type === "redacted_thinking";
}
function hasToolCallInput(block) {
    const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
    const hasArguments = "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
    return hasInput || hasArguments;
}
function toolCallNeedsReplayMutation(block) {
    const rawName = typeof block.name === "string" ? block.name : undefined;
    const trimmedName = rawName?.trim();
    if (rawName && rawName !== trimmedName) {
        return true;
    }
    return hasUnredactedSessionsSpawnAttachments(block);
}
function isReplaySafeThinkingAssistantMessage(message, allowedToolNames) {
    const content = message.content;
    if (!Array.isArray(content)) {
        return false;
    }
    let sawThinking = false;
    let sawToolCall = false;
    const seenToolCallIds = new Set();
    for (const block of content) {
        if (isThinkingLikeBlock(block)) {
            sawThinking = true;
            continue;
        }
        if (!block || typeof block !== "object") {
            continue;
        }
        const typedBlock = block;
        if (typeof typedBlock.type !== "string" || !TOOL_CALL_TYPES.has(typedBlock.type)) {
            continue;
        }
        sawToolCall = true;
        const toolCallId = typeof typedBlock.id === "string" ? typedBlock.id.trim() : "";
        if (!hasToolCallInput(typedBlock) ||
            !toolCallId ||
            seenToolCallIds.has(toolCallId) ||
            !isAllowedToolCallName(typedBlock.name, allowedToolNames) ||
            toolCallNeedsReplayMutation(typedBlock)) {
            return false;
        }
        seenToolCallIds.add(toolCallId);
    }
    return sawThinking && sawToolCall;
}
function collectReplaySafeThinkingToolIds(messages, allowedToolNames) {
    const reserved = new Set();
    const preservedIndexes = new Set();
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== "object" || message.role !== "assistant") {
            continue;
        }
        const assistant = message;
        if (!isReplaySafeThinkingAssistantMessage(assistant, allowedToolNames)) {
            continue;
        }
        const toolCalls = extractToolCallsFromAssistant(assistant);
        if (toolCalls.some((toolCall) => reserved.has(toolCall.id))) {
            continue;
        }
        preservedIndexes.add(index);
        for (const toolCall of toolCalls) {
            reserved.add(toolCall.id);
        }
    }
    return { reservedIds: reserved, preservedIndexes };
}
export function isValidCloudCodeAssistToolId(id, mode = "strict") {
    if (!id || typeof id !== "string") {
        return false;
    }
    if (mode === "strict9") {
        return /^[a-zA-Z0-9]{9}$/.test(id);
    }
    // Strictly alphanumeric for providers with tighter tool ID constraints,
    // plus native IDs we intentionally preserve for replay compatibility.
    return /^[a-zA-Z0-9]+$/.test(id) || isNativeKimiToolCallId(id);
}
function shortHash(text, length = 8) {
    return createHash("sha256").update(text).digest("hex").slice(0, length);
}
function isNativeAnthropicToolUseId(id) {
    return NATIVE_ANTHROPIC_TOOL_USE_ID_RE.test(id);
}
function isNativeKimiToolCallId(id) {
    return NATIVE_KIMI_TOOL_CALL_ID_RE.test(id);
}
function makeUniqueToolId(params) {
    if (params.mode === "strict9") {
        const base = sanitizeToolCallId(params.id, params.mode);
        const candidate = base.length >= STRICT9_LEN ? base.slice(0, STRICT9_LEN) : "";
        if (candidate && !params.used.has(candidate)) {
            return candidate;
        }
        for (let i = 0; i < 1000; i += 1) {
            const hashed = shortHash(`${params.id}:${i}`, STRICT9_LEN);
            if (!params.used.has(hashed)) {
                return hashed;
            }
        }
        return shortHash(`${params.id}:${Date.now()}`, STRICT9_LEN);
    }
    const MAX_LEN = 40;
    const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
    if (!params.used.has(base)) {
        return base;
    }
    const hash = shortHash(params.id);
    // Use separator based on mode: none for strict, underscore for non-strict variants
    const separator = params.mode === "strict" ? "" : "_";
    const maxBaseLen = MAX_LEN - separator.length - hash.length;
    const clippedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
    const candidate = `${clippedBase}${separator}${hash}`;
    if (!params.used.has(candidate)) {
        return candidate;
    }
    for (let i = 2; i < 1000; i += 1) {
        const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
        const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
        if (!params.used.has(next)) {
            return next;
        }
    }
    const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
    return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}
function createOccurrenceAwareResolver(mode, options) {
    const used = new Set(options?.reservedIds ?? []);
    const assistantOccurrences = new Map();
    const orphanToolResultOccurrences = new Map();
    const pendingByRawId = new Map();
    const preserveNativeAnthropicToolUseIds = options?.preserveNativeAnthropicToolUseIds === true;
    const allocate = (seed) => {
        const next = makeUniqueToolId({ id: seed, used, mode });
        used.add(next);
        return next;
    };
    const allocatePreservingNativeAnthropicId = (id, occurrence) => {
        if (preserveNativeAnthropicToolUseIds &&
            isNativeAnthropicToolUseId(id) &&
            occurrence === 1 &&
            !used.has(id)) {
            used.add(id);
            return id;
        }
        return allocate(occurrence === 1 ? id : `${id}:${occurrence}`);
    };
    const resolveAssistantId = (id) => {
        const occurrence = (assistantOccurrences.get(id) ?? 0) + 1;
        assistantOccurrences.set(id, occurrence);
        const next = allocatePreservingNativeAnthropicId(id, occurrence);
        const pending = pendingByRawId.get(id);
        if (pending) {
            pending.push(next);
        }
        else {
            pendingByRawId.set(id, [next]);
        }
        return next;
    };
    const resolveToolResultId = (id) => {
        const pending = pendingByRawId.get(id);
        if (pending && pending.length > 0) {
            const next = pending.shift();
            if (pending.length === 0) {
                pendingByRawId.delete(id);
            }
            return next;
        }
        const occurrence = (orphanToolResultOccurrences.get(id) ?? 0) + 1;
        orphanToolResultOccurrences.set(id, occurrence);
        if (preserveNativeAnthropicToolUseIds &&
            isNativeAnthropicToolUseId(id) &&
            occurrence === 1 &&
            !used.has(id)) {
            used.add(id);
            return id;
        }
        return allocate(`${id}:tool_result:${occurrence}`);
    };
    const preserveAssistantId = (id) => {
        used.add(id);
        const pending = pendingByRawId.get(id);
        if (pending) {
            pending.push(id);
        }
        else {
            pendingByRawId.set(id, [id]);
        }
        return id;
    };
    return { resolveAssistantId, resolveToolResultId, preserveAssistantId };
}
function rewriteAssistantToolCallIds(params) {
    const content = params.message.content;
    if (!Array.isArray(content)) {
        return params.message;
    }
    let changed = false;
    const next = content.map((block) => {
        if (!block || typeof block !== "object") {
            return block;
        }
        const rec = block;
        const type = rec.type;
        const id = rec.id;
        if ((type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
            typeof id !== "string" ||
            !id) {
            return block;
        }
        const nextId = params.resolveId(id);
        if (nextId === id) {
            return block;
        }
        changed = true;
        return Object.assign({}, block, { id: nextId });
    });
    if (!changed) {
        return params.message;
    }
    return { ...params.message, content: next };
}
function rewriteToolResultIds(params) {
    const toolCallId = typeof params.message.toolCallId === "string" && params.message.toolCallId
        ? params.message.toolCallId
        : undefined;
    const toolUseId = params.message.toolUseId;
    const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;
    const sharedRawId = toolCallId && toolUseIdStr && toolCallId === toolUseIdStr ? toolCallId : undefined;
    const sharedResolvedId = sharedRawId ? params.resolveId(sharedRawId) : undefined;
    const nextToolCallId = sharedResolvedId ?? (toolCallId ? params.resolveId(toolCallId) : undefined);
    const nextToolUseId = sharedResolvedId ?? (toolUseIdStr ? params.resolveId(toolUseIdStr) : undefined);
    if (nextToolCallId === toolCallId && nextToolUseId === toolUseIdStr) {
        return params.message;
    }
    return {
        ...params.message,
        ...(nextToolCallId && { toolCallId: nextToolCallId }),
        ...(nextToolUseId && { toolUseId: nextToolUseId }),
    };
}
/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * @param messages - The messages to sanitize
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 */
export function sanitizeToolCallIdsForCloudCodeAssist(messages, mode = "strict", options) {
    // Strict mode: only [a-zA-Z0-9]
    // Strict9 mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
    // Sanitization can introduce collisions, and some providers also reject raw
    // duplicate tool-call IDs. Track assistant occurrences in-order so repeated
    // raw IDs receive distinct rewritten IDs, while matching tool results consume
    // the same rewritten IDs in encounter order.
    const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
    const preserveReplaySafeThinkingToolCallIds = options?.preserveReplaySafeThinkingToolCallIds === true;
    const replaySafeThinking = preserveReplaySafeThinkingToolCallIds
        ? collectReplaySafeThinkingToolIds(messages, allowedToolNames)
        : undefined;
    const { resolveAssistantId, resolveToolResultId, preserveAssistantId } = createOccurrenceAwareResolver(mode, {
        ...options,
        reservedIds: replaySafeThinking?.reservedIds,
    });
    let changed = false;
    const out = messages.map((msg, index) => {
        if (!msg || typeof msg !== "object") {
            return msg;
        }
        const role = msg.role;
        if (role === "assistant") {
            const assistant = msg;
            if (replaySafeThinking?.preservedIndexes.has(index)) {
                for (const toolCall of extractToolCallsFromAssistant(assistant)) {
                    preserveAssistantId(toolCall.id);
                }
                return msg;
            }
            const next = rewriteAssistantToolCallIds({
                message: assistant,
                resolveId: resolveAssistantId,
            });
            if (next !== msg) {
                changed = true;
            }
            return next;
        }
        if (role === "toolResult") {
            const next = rewriteToolResultIds({
                message: msg,
                resolveId: resolveToolResultId,
            });
            if (next !== msg) {
                changed = true;
            }
            return next;
        }
        return msg;
    });
    return changed ? out : messages;
}
