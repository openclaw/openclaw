/** Shared replay decisions; adapters retain payloads or payload-free metadata, never both. */
import type { AgentMessage } from "@openclaw/agent-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  classifyToolPairingFacts,
  type ToolPairingMessageFact,
} from "../../packages/agent-core/src/harness/session/tool-pairing-facts.js";
import {
  type classifyToolUseResultPairing,
  collectCompletedToolCallBlocks,
  collectToolPairingMessageFact,
  makeMissingToolResult,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { replaceCompactionReplayOwnerContent } from "../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import { normalizeLowercaseStringSet } from "../shared/normalized-string-set.js";
import { collectToolCallIds, isContractToolCallBlock } from "../shared/tool-block-contract.js";
import { isThinkingLikeBlock } from "./thinking-block.js";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;

/** Normalize an optional iterable of allowed tool names for lookup. */
export function normalizeAllowedToolNames(allowedToolNames?: Iterable<string>): Set<string> | null {
  if (!allowedToolNames) {
    return null;
  }
  const normalized = normalizeLowercaseStringSet(allowedToolNames);
  return normalized.size > 0 ? normalized : null;
}

/** Return whether a model-supplied tool call name is syntactically and policy allowed. */
export function isAllowedToolCallName(
  name: unknown,
  allowedToolNames: Set<string> | null,
): boolean {
  const trimmed = normalizeOptionalString(name);
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) {
    return false;
  }
  return !allowedToolNames || allowedToolNames.has(trimmed.toLowerCase());
}

/** Completed replay facts survive capability removal without granting live tool authority. */
export function createCompletedToolCallPredicate(
  messages: readonly AgentMessage[],
  pairing?: ReturnType<typeof classifyToolUseResultPairing>,
) {
  const completed = collectCompletedToolCallBlocks(messages, pairing);
  return (block: { name?: unknown }): boolean =>
    completed.has(block) && isAllowedToolCallName(block.name, null);
}

export type ReplayToolBlockFacts = {
  /** Contract calls include snake_case aliases; ID rewriting uses only the camelCase types. */
  toolCall: boolean;
  idToolCall: boolean;
  thinking: boolean;
  id?: string;
  name?: string;
  hasInput: boolean;
  hasIds: boolean;
  hasPartialJson: boolean;
  finalizedOpenAIResponses: boolean;
  hasInputAttachments: boolean;
};

export const TOOL_RESULT_ID_FIELDS = [
  "toolCallId",
  "toolUseId",
  "tool_call_id",
  "tool_use_id",
  "callId",
  "call_id",
] as const;
export type ReplayToolResultIdField = (typeof TOOL_RESULT_ID_FIELDS)[number];
export type ReplayToolResultFacts = {
  /** Raw strings, including whitespace and empty strings, preserve alias rewrite semantics. */
  ids: Partial<Record<ReplayToolResultIdField, string>>;
  name?: string;
};
export type ReplayToolBlockUpdate = { id?: string; name?: string; removePartialJson?: true };
export type ReplayToolResultUpdate = Partial<Record<ReplayToolResultIdField, string>> & {
  toolName?: string;
};
export type MissingReplayToolResult = Parameters<typeof makeMissingToolResult>[0];

/**
 * Metadata getters must describe the current value after every update. Implementations
 * return the original value when unchanged. Block identities survive unmodified rows.
 * No accessor needs argument, text, image, thinking-signature or attachment payloads.
 */
export interface ToolReplayAdapter<Message, Block> {
  valid(message: Message): boolean;
  role(message: Message): string | undefined;
  content(message: Message): readonly Block[] | undefined;
  block(message: Message, block: Block): ReplayToolBlockFacts;
  withContent(message: Message, content: Block[], repair: "inputs" | "ids"): Message;
  withBlock(block: Block, update: ReplayToolBlockUpdate): Block;
  pairing(message: Message): ToolPairingMessageFact | undefined;
  result(message: Message): ReplayToolResultFacts;
  withResult(message: Message, update: ReplayToolResultUpdate): Message;
  timestamp(message: Message): number | undefined;
  missingResult(params: MissingReplayToolResult): Message;
}

export function hasReplayToolCallInput(block: {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
}): boolean {
  return (
    ("input" in block && block.input !== undefined && block.input !== null) ||
    ("arguments" in block && block.arguments !== undefined && block.arguments !== null)
  );
}

/** Derive once while a source row is decoded; none of the returned fields retains payloads. */
export function collectReplayToolBlockFacts(
  message: { role?: unknown; stopReason?: unknown },
  block: unknown,
): ReplayToolBlockFacts {
  const record = asOptionalObjectRecord(block);
  const toolCall = isContractToolCallBlock(block);
  const id = typeof record?.id === "string" ? record.id : undefined;
  const name = typeof record?.name === "string" ? record.name : undefined;
  const partialJson = record?.partialJson;
  const hasPartialJson = typeof partialJson === "string";
  const input = record?.input;
  const args = record?.arguments;
  const attachments = asOptionalObjectRecord(input)?.attachments;
  const separator = id?.indexOf("|") ?? -1;
  return {
    toolCall,
    idToolCall:
      record?.type === "toolCall" || record?.type === "toolUse" || record?.type === "functionCall",
    thinking: isThinkingLikeBlock(block),
    id,
    name,
    hasInput: record ? hasReplayToolCallInput(record) : false,
    hasIds: toolCall && collectToolCallIds(block).length > 0,
    hasPartialJson,
    finalizedOpenAIResponses: Boolean(
      toolCall &&
      message.role === "assistant" &&
      message.stopReason === "toolUse" &&
      hasPartialJson &&
      id !== undefined &&
      !("input" in block) &&
      args &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      (safeParseJsonRecord(partialJson) !== undefined ||
        (partialJson.trim() === "" && Object.keys(args).length === 0)) &&
      separator > 0 &&
      separator < id.length - 1,
    ),
    hasInputAttachments: Array.isArray(attachments) && attachments.length > 0,
  };
}

export function collectReplayToolResultFacts(message: object): ReplayToolResultFacts {
  const record = asOptionalObjectRecord(message)!;
  const ids: ReplayToolResultFacts["ids"] = {};
  for (const field of TOOL_RESULT_ID_FIELDS) {
    if (typeof record[field] === "string") {
      ids[field] = record[field];
    }
  }
  return { ids, name: typeof record.toolName === "string" ? record.toolName : undefined };
}

export function replayToolResultIds(facts: ReplayToolResultFacts): string[] {
  const ids = new Set<string>();
  for (const field of TOOL_RESULT_ID_FIELDS) {
    const id = normalizeOptionalString(facts.ids[field]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** Completed ownership comes from the same occurrence classifier as transcript pairing. */
export function createCompletedToolCallPredicateWithAdapter<Message, Block>(
  messages: readonly Message[],
  adapter: ToolReplayAdapter<Message, Block>,
): (block: Block) => boolean {
  const completed = new Set<Block>();
  for (const frame of classifyToolPairingFacts(
    messages.map((message) => adapter.pairing(message)),
  )) {
    const message = messages[frame.startIndex]!;
    const content = adapter.content(message);
    for (const occurrence of frame.occurrences) {
      if (occurrence.result && !occurrence.result.synthetic && content) {
        const block = content[occurrence.contentIndex];
        if (block !== undefined && isAllowedToolCallName(occurrence.name, null)) {
          completed.add(block);
        }
      }
    }
  }
  return (block) => completed.has(block);
}

/** The array adapter is the only payload-aware implementation used by public repair APIs. */
export const agentMessageToolReplayAdapter: ToolReplayAdapter<AgentMessage, unknown> = {
  valid: (message) => typeof message === "object" && message !== null,
  role: (message) => message?.role,
  content: (message) =>
    message && "content" in message && Array.isArray(message.content) ? message.content : undefined,
  block: (message, block) => collectReplayToolBlockFacts(message, block),
  withContent(message, content, repair) {
    if (message.role !== "assistant") {
      return message;
    }
    // SAFETY: repair kernels only filter this assistant's blocks or rewrite their call IDs/names.
    const nextContent = content as typeof message.content;
    return repair === "inputs"
      ? replaceCompactionReplayOwnerContent(message, nextContent)
      : { ...message, content: nextContent };
  },
  withBlock(block, update) {
    const next = {
      ...asOptionalObjectRecord(block),
      ...("id" in update ? { id: update.id } : {}),
      ...("name" in update ? { name: update.name } : {}),
    };
    if (update.removePartialJson) {
      Reflect.deleteProperty(next, "partialJson");
    }
    return next;
  },
  pairing: collectToolPairingMessageFact,
  result: collectReplayToolResultFacts,
  withResult: (message, update) => ({ ...message, ...update }),
  timestamp: (message) => (message.role === "assistant" ? message.timestamp : undefined),
  missingResult: makeMissingToolResult,
};
