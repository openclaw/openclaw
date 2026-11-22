import type { AgentMessage } from "@openclaw/agent-core";
import {
  createToolCallOccurrenceQueue,
  extractToolCallsFromAssistant,
  extractToolResultId,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
/**
 * Tool call id normalization and extraction helpers.
 *
 * Keeps provider-specific id formats replay-safe while preserving allowed native ids.
 */
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import {
  agentMessageToolReplayAdapter,
  createCompletedToolCallPredicateWithAdapter,
  hasReplayToolCallInput,
  TOOL_RESULT_ID_FIELDS,
  type ReplayToolResultUpdate,
  type ToolReplayAdapter,
  isAllowedToolCallName,
  normalizeAllowedToolNames,
} from "./tool-call-shared.js";

export type ToolCallIdMode = "strict" | "strict9";
const NATIVE_ANTHROPIC_TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_]+$/;
const NATIVE_KIMI_TOOL_CALL_ID_RE = /^functions\.[A-Za-z0-9_-]+:\d+$/;
const OPENAI_TOOL_CALL_ID_RE = /^call_[A-Za-z0-9_-]+$/;

const STRICT9_LEN = 9;

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

export { extractToolCallsFromAssistant, extractToolResultId };

export { hasReplayToolCallInput as hasToolCallInput };

function collectReplaySafeThinkingToolIds<Message, Block>(
  messages: Message[],
  adapter: ToolReplayAdapter<Message, Block>,
  allowedToolNames: Set<string> | null,
): { reservedIds: Set<string>; preservedIndexes: Set<number> } {
  const reserved = new Set<string>();
  const preservedIndexes = new Set<number>();
  const isCompleted = createCompletedToolCallPredicateWithAdapter(messages, adapter);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (!adapter.valid(message) || adapter.role(message) !== "assistant") {
      continue;
    }
    const content = adapter.content(message);
    if (!content) {
      continue;
    }
    let sawThinking = false;
    let sawToolCall = false;
    const seen = new Set<string>();
    const safe = content.every((block) => {
      const facts = adapter.block(message, block);
      if (facts.thinking) {
        sawThinking = true;
        return true;
      }
      if (!facts.idToolCall) {
        return true;
      }
      sawToolCall = true;
      const id = facts.id?.trim();
      if (
        !facts.hasInput ||
        !id ||
        seen.has(id) ||
        !isAllowedToolCallName(facts.name, isCompleted(block) ? null : allowedToolNames) ||
        (Boolean(facts.name) && facts.name !== facts.name?.trim())
      ) {
        return false;
      }
      seen.add(id);
      return true;
    });
    if (!safe || !sawThinking || !sawToolCall) {
      continue;
    }
    const pairing = adapter.pairing(message);
    const calls = pairing?.role === "assistant" ? pairing.calls : [];
    if (calls.some((call) => reserved.has(call.id))) {
      continue;
    }
    preservedIndexes.add(index);
    for (const call of calls) {
      reserved.add(call.id);
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

/** Keeps every persisted tool-result ID alias aligned with its canonical call. */
export function rewriteToolResultIdsWithAdapter<Message, Block>(params: {
  message: Message;
  adapter: ToolReplayAdapter<Message, Block>;
  resolveId: (id: string) => string;
}): Message {
  const { ids } = params.adapter.result(params.message);
  const primaryRawId =
    ids.call_id ||
    ids.callId ||
    ids.tool_call_id ||
    ids.tool_use_id ||
    ids.toolCallId ||
    ids.toolUseId;
  if (!primaryRawId) {
    return params.message;
  }
  const resolvedId = params.resolveId(primaryRawId);
  const updates: ReplayToolResultUpdate = {};
  for (const field of TOOL_RESULT_ID_FIELDS) {
    const rawId = ids[field];
    if (rawId && resolvedId !== rawId) {
      updates[field] = resolvedId;
    }
  }
  if (ids.toolCallId === undefined && resolvedId) {
    updates.toolCallId = resolvedId;
  }
  return Object.keys(updates).length === 0
    ? params.message
    : params.adapter.withResult(params.message, updates);
}

export function rewriteToolResultIds(params: {
  message: Extract<AgentMessage, { role: "toolResult" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return rewriteToolResultIdsWithAdapter({
    ...params,
    adapter: agentMessageToolReplayAdapter,
  }) as Extract<AgentMessage, { role: "toolResult" }>;
}

export type ToolCallIdRepairOptions = {
  preserveNativeAnthropicToolUseIds?: boolean;
  duplicateToolCallIdStyle?: "openai";
  preserveReplaySafeThinkingToolCallIds?: boolean;
  allowedToolNames?: Iterable<string>;
};

/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * @param messages - The messages to sanitize
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 * @param options.duplicateToolCallIdStyle - Optional provider-safe style for repeated IDs
 */
export function sanitizeToolCallIdsForCloudCodeAssistWithAdapter<Message, Block>(
  messages: Message[],
  adapter: ToolReplayAdapter<Message, Block>,
  mode: ToolCallIdMode = "strict",
  options?: ToolCallIdRepairOptions,
): Message[] {
  // Sanitization can introduce collisions, and some providers also reject raw
  // duplicate tool-call IDs. Track assistant occurrences in-order so repeated
  // raw IDs receive distinct rewritten IDs, while matching tool results consume
  // the same rewritten IDs in encounter order.
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const preserveReplaySafeThinkingToolCallIds =
    options?.preserveReplaySafeThinkingToolCallIds === true;
  const replaySafeThinking = preserveReplaySafeThinkingToolCallIds
    ? collectReplaySafeThinkingToolIds(messages, adapter, allowedToolNames)
    : undefined;
  const used = new Set<string>(replaySafeThinking?.reservedIds ?? []);
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
      occurrence === 1 &&
      !used.has(id) &&
      ((duplicateToolCallIdStyle === "openai" && OPENAI_TOOL_CALL_ID_RE.test(id)) ||
        (preserveNativeAnthropicToolUseIds && NATIVE_ANTHROPIC_TOOL_USE_ID_RE.test(id)))
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

  let changed = false;
  const out = messages.map((message, index) => {
    if (!adapter.valid(message)) {
      return message;
    }
    const role = adapter.role(message);
    let next = message;
    if (role === "assistant") {
      if (replaySafeThinking?.preservedIndexes.has(index)) {
        const pairing = adapter.pairing(message);
        if (pairing?.role === "assistant") {
          for (const call of pairing.calls) {
            preserveAssistantId(call.id);
          }
        }
        return message;
      }
      const content = adapter.content(message);
      if (!content) {
        return message;
      }
      let assistantChanged = false;
      const nextContent = content.map((block) => {
        const { idToolCall, id } = adapter.block(message, block);
        if (!idToolCall || !id) {
          return block;
        }
        const nextId = resolveAssistantId(id);
        if (nextId === id) {
          return block;
        }
        assistantChanged = true;
        return adapter.withBlock(block, { id: nextId });
      });
      if (assistantChanged) {
        next = adapter.withContent(message, nextContent, "ids");
      }
    } else if (role === "toolResult") {
      next = rewriteToolResultIdsWithAdapter({
        message,
        adapter,
        resolveId: resolveToolResultId,
      });
    }
    changed ||= next !== message;
    return next;
  });
  return changed ? out : messages;
}

export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "strict",
  options?: ToolCallIdRepairOptions,
): AgentMessage[] {
  return sanitizeToolCallIdsForCloudCodeAssistWithAdapter(
    messages,
    agentMessageToolReplayAdapter,
    mode,
    options,
  );
}
