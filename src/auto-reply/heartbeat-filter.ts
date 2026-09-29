import { expectDefined } from "@openclaw/normalization-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
// Transcript filter for removing heartbeat-only prompt/ack artifacts.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import {
  collectToolCallIds,
  isContractToolCallBlock,
  isContractToolResultBlock,
  readToolCallName,
} from "../shared/tool-block-contract.js";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "./heartbeat-tool-response.js";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  INTERNAL_WAKE_TRANSCRIPT_PROMPTS,
  isHeartbeatAcknowledgementText,
  resolveHeartbeatPromptForResponseTool,
} from "./heartbeat.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "./reply/delivery-hints.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "./tokens.js";

const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_COMPLETIONS = [
  ...[HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN].map(
    (token) => `After completing all due tasks, reply ${token}.`,
  ),
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  `After completing all due tasks, use ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
];
type HeartbeatTranscriptMessage = { role: string; content?: unknown };

function collectToolCallBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(isContractToolCallBlock);
}

function collectToolResultBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(isContractToolResultBlock);
}

function readNestedToolCallArguments(record: Record<string, unknown>): unknown {
  const value = record.function;
  if (!isRecord(value)) {
    return undefined;
  }
  return value.arguments ?? value.args ?? value.input;
}

function readToolCallArguments(block: Record<string, unknown>): unknown {
  return block.arguments ?? block.args ?? block.input ?? readNestedToolCallArguments(block);
}

function parseToolCallArguments(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  return typeof value === "string" ? safeParseJsonRecord(value) : undefined;
}

function isVisibleHeartbeatResponseToolCall(block: Record<string, unknown>): boolean {
  const args = parseToolCallArguments(readToolCallArguments(block));
  if (!args) {
    return false;
  }
  return args.notify === true || args.notify === "true";
}

function collectVisibleHeartbeatResponseToolCalls(
  message: HeartbeatTranscriptMessage,
): Array<Record<string, unknown>> {
  return collectAssistantToolCalls(message).filter(
    (block) =>
      readToolCallName(block) === HEARTBEAT_RESPONSE_TOOL_NAME &&
      isVisibleHeartbeatResponseToolCall(block),
  );
}

function collectAssistantToolCalls(message: HeartbeatTranscriptMessage) {
  if (message.role !== "assistant") {
    return [];
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  return [
    ...(Array.isArray(toolCalls) ? toolCalls.filter(isRecord) : []),
    ...collectToolCallBlocks(message.content),
  ];
}

function hasAssistantToolCall(message: HeartbeatTranscriptMessage): boolean {
  return collectAssistantToolCalls(message).length > 0;
}

function isRemovableHeartbeatResponseToolCall(message: HeartbeatTranscriptMessage): boolean {
  return collectAssistantToolCalls(message).some(
    (block) =>
      readToolCallName(block) === HEARTBEAT_RESPONSE_TOOL_NAME &&
      !isVisibleHeartbeatResponseToolCall(block),
  );
}

function hasVisibleHeartbeatResponseToolCall(message: HeartbeatTranscriptMessage): boolean {
  return collectVisibleHeartbeatResponseToolCalls(message).length > 0;
}

function isEmbeddedToolResultOnlyContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => isContractToolResultBlock(block))
  );
}

function isToolResultMessage(message: HeartbeatTranscriptMessage): boolean {
  return (
    message.role === "toolResult" ||
    message.role === "tool" ||
    (message.role === "user" && isEmbeddedToolResultOnlyContent(message.content))
  );
}

function isFailedToolResultRecord(record: Record<string, unknown>): boolean {
  return (
    record.isError === true ||
    record.is_error === true ||
    readString(record.type) === "tool_result_error"
  );
}

function hasSuccessfulToolResultMessage(message: HeartbeatTranscriptMessage): boolean {
  const resultBlocks = collectToolResultBlocks(message.content);
  if (resultBlocks.length > 0) {
    return resultBlocks.some((block) => !isFailedToolResultRecord(block));
  }
  if (!isToolResultMessage(message)) {
    return false;
  }
  return !isFailedToolResultRecord(message as Record<string, unknown>);
}

function collectSuccessfulToolResultCallIds(message: HeartbeatTranscriptMessage): string[] {
  const record = message as Record<string, unknown>;
  const resultBlocks = collectToolResultBlocks(message.content);
  const ids: string[] = [];
  if (resultBlocks.length === 0) {
    if (!isFailedToolResultRecord(record)) {
      ids.push(...collectToolCallIds(record));
    }
  } else {
    for (const block of resultBlocks) {
      if (isFailedToolResultRecord(block)) {
        continue;
      }
      ids.push(...collectToolCallIds(block));
    }
  }
  return [...new Set(ids)];
}

function matchesHeartbeatPromptText(text: string, prompt: string | undefined): boolean {
  const normalized = prompt?.trim();
  return Boolean(normalized) && (text === normalized || text.startsWith(`${normalized}\n`));
}

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  let text = "";
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      hasNonTextContent = true;
      continue;
    }
    // Provider thinking/reasoning is not user-visible output; it must not keep a
    // no-op heartbeat acknowledgement in future model request history.
    if (
      block.type === "thinking" ||
      block.type === "reasoning" ||
      block.type === "redacted_thinking"
    ) {
      continue;
    }
    if (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text") {
      hasNonTextContent = true;
      continue;
    }
    const blockText = (block as { text?: unknown }).text;
    if (typeof blockText !== "string") {
      hasNonTextContent = true;
      continue;
    }
    text += blockText;
  }
  return { text, hasNonTextContent };
}

/** Return whether a user message is an internal heartbeat prompt. */
export function isHeartbeatUserMessage(
  message: HeartbeatTranscriptMessage,
  heartbeatPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedHeartbeatPrompt = heartbeatPrompt?.trim();
  const transcriptPrompts = Object.values(INTERNAL_WAKE_TRANSCRIPT_PROMPTS);
  if (transcriptPrompts.some((prompt) => trimmed === prompt)) {
    return true;
  }
  if (
    MESSAGE_TOOL_DELIVERY_HINTS.some((prefix) => trimmed.startsWith(prefix)) &&
    transcriptPrompts.some((prompt) => trimmed.endsWith(prompt))
  ) {
    return true;
  }
  if (matchesHeartbeatPromptText(trimmed, normalizedHeartbeatPrompt)) {
    return true;
  }
  if (matchesHeartbeatPromptText(trimmed, HEARTBEAT_RESPONSE_TOOL_PROMPT)) {
    return true;
  }
  if (
    normalizedHeartbeatPrompt &&
    matchesHeartbeatPromptText(
      trimmed,
      resolveHeartbeatPromptForResponseTool(normalizedHeartbeatPrompt),
    )
  ) {
    return true;
  }
  return (
    trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) &&
    HEARTBEAT_TASK_PROMPT_COMPLETIONS.some((completion) => trimmed.includes(completion))
  );
}

/** Return whether an assistant message is only a heartbeat acknowledgement. */
export function isHeartbeatOkResponse(
  message: HeartbeatTranscriptMessage,
  ackMaxChars?: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if (hasAssistantToolCall(message)) {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  return isHeartbeatAcknowledgementText(text, ackMaxChars);
}

function advancePastAdjacentToolResults(
  messages: HeartbeatTranscriptMessage[],
  startIndex: number,
): number {
  let index = startIndex;
  while (index < messages.length) {
    const message = messages.at(index);
    if (!message || !isToolResultMessage(message)) {
      break;
    }
    index++;
  }
  return index;
}

function isToolResultCompletionCandidate(message: HeartbeatTranscriptMessage): boolean {
  return isToolResultMessage(message) || collectToolResultBlocks(message.content).length > 0;
}

function hasCompletedVisibleHeartbeatResponseToolCall(
  messages: HeartbeatTranscriptMessage[],
  index: number,
): boolean {
  const message = messages.at(index);
  if (!message) {
    return false;
  }
  const visibleCalls = collectVisibleHeartbeatResponseToolCalls(message);
  if (visibleCalls.length === 0) {
    return false;
  }
  const callIds = new Set(visibleCalls.flatMap((call) => collectToolCallIds(call)));
  for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
    const result = expectDefined(messages[resultIndex], "messages entry at resultIndex");
    if (!isToolResultCompletionCandidate(result)) {
      break;
    }
    if (!hasSuccessfulToolResultMessage(result)) {
      continue;
    }
    if (callIds.size === 0) {
      return true;
    }
    for (const resultId of collectSuccessfulToolResultCallIds(result)) {
      if (callIds.has(resultId)) {
        return true;
      }
    }
  }
  return false;
}

function resolveHeartbeatArtifactSpanEnd(
  messages: HeartbeatTranscriptMessage[],
  startIndex: number,
  ackMaxChars?: number,
): number | undefined {
  let index = startIndex + 1;
  let sawTerminalHeartbeatArtifact = false;
  let sawNonTerminalAssistantOutput = false;

  while (index < messages.length) {
    const message = messages.at(index);
    if (!message) {
      break;
    }
    // Both the next wake and an ordinary user turn end this heartbeat span.
    if (message.role === "user" && !isEmbeddedToolResultOnlyContent(message.content)) {
      break;
    }
    if (isHeartbeatOkResponse(message, ackMaxChars)) {
      sawTerminalHeartbeatArtifact = true;
      index = advancePastAdjacentToolResults(messages, index + 1);
      continue;
    }
    if (hasVisibleHeartbeatResponseToolCall(message)) {
      if (hasCompletedVisibleHeartbeatResponseToolCall(messages, index)) {
        return undefined;
      }
      index++;
      continue;
    }
    if (isRemovableHeartbeatResponseToolCall(message)) {
      sawTerminalHeartbeatArtifact = true;
      index = advancePastAdjacentToolResults(messages, index + 1);
      continue;
    }
    if (sawTerminalHeartbeatArtifact) {
      index++;
      continue;
    }
    if (isToolResultMessage(message) || hasAssistantToolCall(message)) {
      index++;
      continue;
    }
    if (message.role === "assistant") {
      sawNonTerminalAssistantOutput = true;
      index++;
      continue;
    }
    return undefined;
  }

  if (sawNonTerminalAssistantOutput && !sawTerminalHeartbeatArtifact) {
    return undefined;
  }
  return index;
}

/** Remove heartbeat-only prompt, ack, and silent tool artifacts from a transcript. */
export function filterHeartbeatTranscriptArtifacts<T extends HeartbeatTranscriptMessage>(
  messages: T[],
  ackMaxChars?: number,
  heartbeatPrompt?: string,
): T[] {
  if (messages.length === 0) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    if (
      !isHeartbeatUserMessage(expectDefined(messages[i], "messages entry at i"), heartbeatPrompt)
    ) {
      result.push(expectDefined(messages[i], "messages entry at i"));
      i++;
      continue;
    }

    const next = resolveHeartbeatArtifactSpanEnd(messages, i, ackMaxChars);
    if (next === undefined) {
      result.push(expectDefined(messages[i], "messages entry at i"));
      i++;
      continue;
    }

    i = next;
  }

  return result;
}
