import type { AgentMessage } from "@openclaw/agent-core";
import {
  createToolCallOccurrenceQueue,
  extractToolCallsFromAssistant,
  extractToolResultId,
  extractToolResultIds,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
/**
 * Tool call id normalization and extraction helpers.
 *
 * Keeps provider-specific id formats replay-safe while preserving allowed native ids.
 */
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { isThinkingLikeBlock } from "./thinking-block.js";
import {
  createCompletedToolCallPredicate,
  isAllowedToolCallName,
  normalizeAllowedToolNames,
} from "./tool-call-shared.js";

export type ToolCallIdMode = "strict" | "strict9";
const NATIVE_ANTHROPIC_TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_]+$/;
const NATIVE_KIMI_TOOL_CALL_ID_RE = /^functions\.[A-Za-z0-9_-]+:\d+$/;
const OPENAI_TOOL_CALL_ID_RE = /^call_[A-Za-z0-9_-]+$/;

const STRICT9_LEN = 9;
const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);

type ReplaySafeToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "strict" mode: only [a-zA-Z0-9]
 * - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
 */
function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (!id) {
    return mode === "strict9" ? "defaultid" : "defaulttoolid";
  }

  if (mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    return sha256HexPrefixCore(alphanumericOnly || "sanitized", STRICT9_LEN);
  }

  if (NATIVE_KIMI_TOOL_CALL_ID_RE.test(id)) {
    return id;
  }

  // Some providers require strictly alphanumeric tool call IDs.
  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}

export { extractToolCallsFromAssistant, extractToolResultId, extractToolResultIds };

export function hasToolCallInput(block: ReplaySafeToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function toolCallNeedsReplayMutation(block: ReplaySafeToolCallBlock): boolean {
  const rawName = typeof block.name === "string" ? block.name : undefined;
  const trimmedName = rawName?.trim();
  return Boolean(rawName) && rawName !== trimmedName;
}

function isReplaySafeThinkingAssistantMessage(
  message: Extract<AgentMessage, { role: "assistant" }>,
  allowedToolNames: Set<string> | null,
  isCompleted: ReturnType<typeof createCompletedToolCallPredicate>,
): boolean {
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  let sawThinking = false;
  let sawToolCall = false;
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (isThinkingLikeBlock(block)) {
      sawThinking = true;
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as ReplaySafeToolCallBlock;
    if (typeof typedBlock.type !== "string" || !TOOL_CALL_TYPES.has(typedBlock.type)) {
      continue;
    }
    sawToolCall = true;
    const toolCallId = typeof typedBlock.id === "string" ? typedBlock.id.trim() : "";
    if (
      !hasToolCallInput(typedBlock) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      !isAllowedToolCallName(typedBlock.name, isCompleted(typedBlock) ? null : allowedToolNames) ||
      toolCallNeedsReplayMutation(typedBlock)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
  }
  return sawThinking && sawToolCall;
}

function collectReplaySafeThinkingToolIds(
  messages: AgentMessage[],
  allowedToolNames: Set<string> | null,
): { reservedIds: Set<string>; preservedIndexes: Set<number> } {
  const reserved = new Set<string>();
  const preservedIndexes = new Set<number>();
  const isCompleted = createCompletedToolCallPredicate(messages);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      continue;
    }
    if (!isReplaySafeThinkingAssistantMessage(message, allowedToolNames, isCompleted)) {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(message);
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

function makeUniqueToolId(params: { id: string; used: Set<string>; mode: ToolCallIdMode }): string {
  if (params.mode === "strict9") {
    const candidate = sanitizeToolCallId(params.id, params.mode);
    if (!params.used.has(candidate)) {
      return candidate;
    }

    for (let i = 0; i < 1000; i += 1) {
      const hashed = sha256HexPrefixCore(`${params.id}:${i}`, STRICT9_LEN);
      if (!params.used.has(hashed)) {
        return hashed;
      }
    }

    return sha256HexPrefixCore(`${params.id}:${Date.now()}`, STRICT9_LEN);
  }

  const MAX_LEN = 40;

  const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
  if (!params.used.has(base)) {
    return base;
  }

  const hash = sha256HexPrefixCore(params.id, 8);
  const candidate = `${base.slice(0, MAX_LEN - hash.length)}${hash}`;
  if (!params.used.has(candidate)) {
    return candidate;
  }

  for (let i = 2; i < 1000; i += 1) {
    const suffix = `x${i}`;
    const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
    if (!params.used.has(next)) {
      return next;
    }
  }

  const ts = `t${Date.now()}`;
  return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}

function createOccurrenceAwareResolver(
  mode: ToolCallIdMode,
  options?: {
    preserveNativeAnthropicToolUseIds?: boolean;
    duplicateToolCallIdStyle?: "openai";
    reservedIds?: Iterable<string>;
  },
): {
  resolveAssistantId: (id: string) => string;
  resolveToolResultId: (id: string) => string;
  preserveAssistantId: (id: string) => string;
} {
  const used = new Set<string>(options?.reservedIds ?? []);
  const assistantOccurrences = new Map<string, number>();
  const orphanToolResultOccurrences = new Map<string, number>();
  const pendingByRawId = createToolCallOccurrenceQueue<string>();
  const preserveNativeAnthropicToolUseIds = options?.preserveNativeAnthropicToolUseIds === true;
  const duplicateToolCallIdStyle = options?.duplicateToolCallIdStyle;

  const allocate = (seed: string): string => {
    const next = makeUniqueToolId({ id: seed, used, mode });
    used.add(next);
    return next;
  };

  const allocateOpenAIStyleId = (id: string, occurrence: number): string => {
    for (let attempt = 0; ; attempt += 1) {
      const candidate = `call_${sha256HexPrefixCore(`${id}:${occurrence}:${attempt}`, 24)}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  const allocatePreservingNativeAnthropicId = (id: string, occurrence: number): string => {
    if (
      duplicateToolCallIdStyle === "openai" &&
      occurrence === 1 &&
      OPENAI_TOOL_CALL_ID_RE.test(id) &&
      !used.has(id)
    ) {
      used.add(id);
      return id;
    }
    if (
      preserveNativeAnthropicToolUseIds &&
      NATIVE_ANTHROPIC_TOOL_USE_ID_RE.test(id) &&
      occurrence === 1 &&
      !used.has(id)
    ) {
      used.add(id);
      return id;
    }
    return allocate(occurrence === 1 ? id : `${id}:${occurrence}`);
  };

  const resolveAssistantId = (id: string): string => {
    const occurrence = (assistantOccurrences.get(id) ?? 0) + 1;
    assistantOccurrences.set(id, occurrence);
    const next =
      duplicateToolCallIdStyle === "openai" && occurrence > 1
        ? allocateOpenAIStyleId(id, occurrence)
        : allocatePreservingNativeAnthropicId(id, occurrence);
    pendingByRawId.add(id, next);
    return next;
  };

  const resolveToolResultId = (id: string): string => {
    const next = pendingByRawId.claim(id);
    if (next !== undefined) {
      return next;
    }

    const occurrence = (orphanToolResultOccurrences.get(id) ?? 0) + 1;
    orphanToolResultOccurrences.set(id, occurrence);
    if (
      preserveNativeAnthropicToolUseIds &&
      NATIVE_ANTHROPIC_TOOL_USE_ID_RE.test(id) &&
      occurrence === 1 &&
      !used.has(id)
    ) {
      used.add(id);
      return id;
    }
    return allocate(`${id}:tool_result:${occurrence}`);
  };

  const preserveAssistantId = (id: string): string => {
    used.add(id);
    pendingByRawId.add(id, id);
    return id;
  };

  return { resolveAssistantId, resolveToolResultId, preserveAssistantId };
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<AgentMessage, { role: "assistant" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "assistant" }> {
  const content = params.message.content;
  if (!Array.isArray(content)) {
    return params.message;
  }

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const rec = block as { type?: unknown; id?: unknown };
    const type = rec.type;
    const id = rec.id;
    if (
      (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
      typeof id !== "string" ||
      !id
    ) {
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
  return { ...params.message, content: next as typeof params.message.content };
}

/** Keeps every persisted tool-result ID alias aligned with its canonical call. */
export function rewriteToolResultIds(params: {
  message: Extract<AgentMessage, { role: "toolResult" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  const idFields = [
    "toolCallId",
    "toolUseId",
    "tool_call_id",
    "tool_use_id",
    "callId",
    "call_id",
  ] as const;
  const record = params.message as Extract<AgentMessage, { role: "toolResult" }> &
    Record<(typeof idFields)[number], unknown>;
  const rawIds = new Map<(typeof idFields)[number], string>();
  for (const field of idFields) {
    const rawId = record[field];
    if (typeof rawId === "string" && rawId) {
      rawIds.set(field, rawId);
    }
  }

  const primaryRawId =
    rawIds.get("call_id") ??
    rawIds.get("callId") ??
    rawIds.get("tool_call_id") ??
    rawIds.get("tool_use_id") ??
    rawIds.get("toolCallId") ??
    rawIds.get("toolUseId");

  if (!primaryRawId) {
    return params.message;
  }

  const resolvedId = params.resolveId(primaryRawId);
  const updates: Partial<Record<(typeof idFields)[number], string>> = {};

  for (const [field, rawId] of rawIds) {
    if (resolvedId !== rawId) {
      updates[field] = resolvedId;
    }
  }

  if (typeof record.toolCallId !== "string" && resolvedId) {
    updates.toolCallId = resolvedId;
  }

  if (Object.keys(updates).length === 0) {
    return params.message;
  }

  return {
    ...params.message,
    ...updates,
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * @param messages - The messages to sanitize
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 * @param options.duplicateToolCallIdStyle - Optional provider-safe style for repeated IDs
 */
export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "strict",
  options?: {
    preserveNativeAnthropicToolUseIds?: boolean;
    duplicateToolCallIdStyle?: "openai";
    preserveReplaySafeThinkingToolCallIds?: boolean;
    allowedToolNames?: Iterable<string>;
  },
): AgentMessage[] {
  // Strict mode: only [a-zA-Z0-9]
  // Strict9 mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
  // Sanitization can introduce collisions, and some providers also reject raw
  // duplicate tool-call IDs. Track assistant occurrences in-order so repeated
  // raw IDs receive distinct rewritten IDs, while matching tool results consume
  // the same rewritten IDs in encounter order.
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const preserveReplaySafeThinkingToolCallIds =
    options?.preserveReplaySafeThinkingToolCallIds === true;
  const replaySafeThinking = preserveReplaySafeThinkingToolCallIds
    ? collectReplaySafeThinkingToolIds(messages, allowedToolNames)
    : undefined;
  const { resolveAssistantId, resolveToolResultId, preserveAssistantId } =
    createOccurrenceAwareResolver(mode, {
      ...options,
      reservedIds: replaySafeThinking?.reservedIds,
    });

  let changed = false;
  const out = messages.map((msg, index) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
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
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
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
