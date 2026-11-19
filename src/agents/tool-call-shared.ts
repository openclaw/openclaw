/** Shared replay decisions; adapters retain payloads or payload-free metadata, never both. */
import type { AgentMessage } from "@openclaw/agent-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";
import { normalizeLowercaseStringSet } from "../shared/normalized-string-set.js";
import { collectToolCallIds, isContractToolCallBlock } from "../shared/tool-block-contract.js";
import { isThinkingLikeBlock } from "./thinking-block.js";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;
const CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS = ["encoding", "mimeType"] as const;
const LEGACY_CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS = [
  "name",
  ...CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS,
] as const;
const TRANSCRIPT_TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

type TranscriptToolCallSanitizeOptions = {
  preserveLegacyContinueDelegateAttachmentName?: boolean;
};

export function isTranscriptToolCallBlock(
  value: unknown,
): value is { type: string; name?: unknown; input?: unknown; arguments?: unknown } {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    TRANSCRIPT_TOOL_CALL_BLOCK_TYPES.has(value.type)
  );
}

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

function redactContinueDelegateAttachmentContent(
  value: unknown,
  options?: TranscriptToolCallSanitizeOptions,
): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const redacted = redactContinueDelegateAttachmentContent(parsed, options);
      return redacted === parsed ? value : JSON.stringify(redacted);
    } catch {
      return value;
    }
  }
  if (!isRecord(value)) {
    return value;
  }
  let sanitized = value;
  if (Object.hasOwn(value, "attachments")) {
    if (!Array.isArray(value.attachments)) {
      sanitized = { ...value };
      delete sanitized.attachments;
    } else {
      let changed = false;
      const attachments = value.attachments.map((attachment) => {
        if (
          isRedactedContinueDelegateAttachment(
            attachment,
            options?.preserveLegacyContinueDelegateAttachmentName === true,
          )
        ) {
          return attachment;
        }
        changed = true;
        return redactContinueDelegateAttachment(attachment);
      });
      if (changed) {
        sanitized = { ...value, attachments };
      }
    }
  }
  return sanitizeContinueDelegateAttachAs(
    sanitized,
    Array.isArray(sanitized.attachments) && sanitized.attachments.length > 0,
  );
}

function sanitizeContinueDelegateAttachAs(
  input: Record<string, unknown>,
  hasAttachments: boolean,
): Record<string, unknown> {
  const hasCamel = Object.hasOwn(input, "attachAs");
  const hasSnake = Object.hasOwn(input, "attach_as");
  if (!hasCamel && !hasSnake) {
    return input;
  }
  const key = hasCamel ? "attachAs" : "attach_as";
  const shadowKey = hasCamel ? "attach_as" : "attachAs";
  const attachAs = hasAttachments ? projectContinueDelegateAttachAs(input[key]) : undefined;
  if (attachAs === input[key] && !Object.hasOwn(input, shadowKey)) {
    return input;
  }
  const sanitized = { ...input };
  if (attachAs) {
    sanitized[key] = attachAs;
  } else {
    delete sanitized[key];
  }
  delete sanitized[shadowKey];
  return sanitized;
}

function projectContinueDelegateAttachAs(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const hasCamel = Object.hasOwn(value, "mountPath");
  const hasSnake = Object.hasOwn(value, "mount_path");
  const key = hasCamel ? "mountPath" : hasSnake ? "mount_path" : undefined;
  if (!key || typeof value[key] !== "string" || value[key].trim().length === 0) {
    return undefined;
  }
  return Object.keys(value).length === 1 ? value : { [key]: value[key] };
}

function isRedactedContinueDelegateAttachment(value: unknown, allowLegacyName: boolean): boolean {
  if (!isRecord(value) || value.content !== REDACTED_SENTINEL) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (key === "content") {
      continue;
    }
    const allowedKeys = allowLegacyName
      ? LEGACY_CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS
      : CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS;
    if (!allowedKeys.some((allowedKey) => allowedKey === key)) {
      return false;
    }
    const metadata = value[key];
    if (typeof metadata !== "string" || metadata.trim().length === 0) {
      return false;
    }
    if (key === "encoding" && metadata !== "utf8" && metadata !== "base64") {
      return false;
    }
  }
  return true;
}

function redactContinueDelegateAttachment(value: unknown): Record<string, unknown> {
  const redacted: Record<string, unknown> = { content: REDACTED_SENTINEL };
  if (!isRecord(value)) {
    return redacted;
  }
  for (const key of CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS) {
    const metadata = value[key];
    if (typeof metadata !== "string" || metadata.trim().length === 0) {
      continue;
    }
    if (key === "encoding" && metadata !== "utf8" && metadata !== "base64") {
      continue;
    }
    redacted[key] = metadata;
  }
  return redacted;
}

export function sanitizeTranscriptToolCallBlock<
  T extends {
    name?: unknown;
    input?: unknown;
    arguments?: unknown;
    partialArgs?: unknown;
    partialJson?: unknown;
  },
>(block: T, options?: TranscriptToolCallSanitizeOptions): T {
  const rawName = typeof block.name === "string" ? block.name : undefined;
  const trimmedName = rawName?.trim();
  const normalizedName = trimmedName ? trimmedName : undefined;
  const nameChanged = normalizedName !== undefined && rawName !== normalizedName;
  const isContinueDelegate = normalizedName?.toLowerCase() === "continue_delegate";
  const input = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.input, options)
    : block.input;
  const args = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.arguments, options)
    : block.arguments;
  const removePartialArgs = isContinueDelegate && Object.hasOwn(block, "partialArgs");
  const removePartialJson = isContinueDelegate && Object.hasOwn(block, "partialJson");
  if (
    !nameChanged &&
    input === block.input &&
    args === block.arguments &&
    !removePartialArgs &&
    !removePartialJson
  ) {
    return block;
  }
  // SAFETY: spreading T preserves its own enumerable properties while the mutations retain T's shape.
  const next = { ...block } as T;
  if (nameChanged) {
    next.name = normalizedName;
  }
  if ("input" in block) {
    next.input = input;
  }
  if ("arguments" in block) {
    next.arguments = args;
  }
  if (removePartialArgs) {
    delete next.partialArgs;
  }
  if (removePartialJson) {
    delete next.partialJson;
  }
  return next;
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
  /**
   * Continuation, payload adapter only: a continue_delegate call whose attachment snapshot the
   * transcript writer would still redact. "legacy" differs only by the retired attachment
   * `name`, which signed thinking replay may keep; "unredacted" also fails that replay.
   */
  continueDelegateSnapshot?: "legacy" | "unredacted";
};

export const TOOL_RESULT_ID_FIELDS = [
  "toolCallId",
  "toolUseId",
  "tool_call_id",
  "tool_use_id",
  "callId",
  "call_id",
] as const;
type ReplayToolResultIdField = (typeof TOOL_RESULT_ID_FIELDS)[number];
export type ReplayToolResultFacts = {
  /** Raw strings, including whitespace and empty strings, preserve alias rewrite semantics. */
  ids: Partial<Record<ReplayToolResultIdField, string>>;
  name?: string;
};
type ReplayToolBlockUpdate = {
  id?: string;
  name?: string;
  removePartialJson?: true;
  redactContinueDelegate?: true;
};
export type ReplayToolResultUpdate = Partial<Record<ReplayToolResultIdField, string>> & {
  toolName?: string;
};
type MissingReplayToolResult = Parameters<typeof makeMissingToolResult>[0];

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

function readContinueDelegateSnapshot(
  block: unknown,
): ReplayToolBlockFacts["continueDelegateSnapshot"] {
  if (
    !isTranscriptToolCallBlock(block) ||
    normalizeOptionalString(block.name)?.toLowerCase() !== "continue_delegate"
  ) {
    return undefined;
  }
  if (
    sanitizeTranscriptToolCallBlock(block, { preserveLegacyContinueDelegateAttachmentName: true }) !==
    block
  ) {
    return "unredacted";
  }
  return sanitizeTranscriptToolCallBlock(block) === block ? undefined : "legacy";
}

/** The array adapter is the only payload-aware implementation used by public repair APIs. */
export const agentMessageToolReplayAdapter: ToolReplayAdapter<AgentMessage, unknown> = {
  valid: (message) => typeof message === "object" && message !== null,
  role: (message) => message?.role,
  content: (message) =>
    message && "content" in message && Array.isArray(message.content) ? message.content : undefined,
  block: (message, block) => {
    const facts = collectReplayToolBlockFacts(message, block);
    const continueDelegateSnapshot = facts.toolCall ? readContinueDelegateSnapshot(block) : undefined;
    return continueDelegateSnapshot ? { ...facts, continueDelegateSnapshot } : facts;
  },
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
    return update.redactContinueDelegate ? sanitizeTranscriptToolCallBlock(next) : next;
  },
  pairing: collectToolPairingMessageFact,
  result: collectReplayToolResultFacts,
  withResult: (message, update) => ({ ...message, ...update }),
  timestamp: (message) => (message.role === "assistant" ? message.timestamp : undefined),
  missingResult: makeMissingToolResult,
};
