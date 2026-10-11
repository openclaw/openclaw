import { expectDefined } from "@openclaw/normalization-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "../plugin-sdk/message-tool-delivery-hints.js";
import {
  collectToolCallIds,
  isContractToolCallBlock,
  isContractToolResultBlock,
  readToolCallName,
} from "../shared/tool-block-contract.js";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  HEARTBEAT_RESPONSE_TOOL_PROMPT,
  INTERNAL_WAKE_TRANSCRIPT_PROMPTS,
  isHeartbeatAcknowledgementText,
  resolveHeartbeatPromptForResponseTool,
} from "./heartbeat.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "./tokens.js";

const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";
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

function isVisibleHeartbeatResponseToolCall(block: Record<string, unknown>): boolean {
  const nested = isRecord(block.function) ? block.function : undefined;
  const value =
    block.arguments ??
    block.args ??
    block.input ??
    nested?.arguments ??
    nested?.args ??
    nested?.input;
  const args = isRecord(value)
    ? value
    : typeof value === "string"
      ? safeParseJsonRecord(value)
      : undefined;
  return args?.notify === true || args?.notify === "true";
}

function collectAssistantToolCalls(message: HeartbeatTranscriptMessage) {
  if (message.role !== "assistant") {
    return [];
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  return [
    ...(Array.isArray(toolCalls) ? toolCalls.filter(isRecord) : []),
    ...(Array.isArray(message.content) ? message.content.filter(isContractToolCallBlock) : []),
  ];
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

function matchesHeartbeatPromptText(text: string, prompt: string | undefined): boolean {
  return Boolean(prompt) && (text === prompt || text.startsWith(`${prompt}\n`));
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
  if (
    matchesHeartbeatPromptText(trimmed, normalizedHeartbeatPrompt) ||
    matchesHeartbeatPromptText(trimmed, HEARTBEAT_RESPONSE_TOOL_PROMPT) ||
    (normalizedHeartbeatPrompt &&
      matchesHeartbeatPromptText(
        trimmed,
        resolveHeartbeatPromptForResponseTool(normalizedHeartbeatPrompt),
      ))
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
  if (message.role !== "assistant" || collectAssistantToolCalls(message).length > 0) {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  return !hasNonTextContent && isHeartbeatAcknowledgementText(text, ackMaxChars);
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

function hasCompletedVisibleHeartbeatResponseToolCall(
  messages: HeartbeatTranscriptMessage[],
  index: number,
  visibleCalls: Array<Record<string, unknown>>,
): boolean {
  const callIds = new Set(visibleCalls.flatMap((call) => collectToolCallIds(call)));
  for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
    const result = expectDefined(messages[resultIndex], "messages entry at resultIndex");
    const { content } = result;
    const blocks = Array.isArray(content) ? content.filter(isContractToolResultBlock) : [];
    if (blocks.length === 0 && !isToolResultMessage(result)) {
      break;
    }
    const records: Array<Record<string, unknown>> = blocks.length > 0 ? blocks : [result];
    if (
      records.some(
        (record) =>
          record.isError !== true &&
          record.is_error !== true &&
          readString(record.type) !== "tool_result_error" &&
          (callIds.size === 0 || collectToolCallIds(record).some((id) => callIds.has(id))),
      )
    ) {
      return true;
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
    const toolCalls = collectAssistantToolCalls(message);
    const heartbeatCalls = toolCalls.filter(
      (block) => readToolCallName(block) === HEARTBEAT_RESPONSE_TOOL_NAME,
    );
    const visibleCalls = heartbeatCalls.filter(isVisibleHeartbeatResponseToolCall);
    if (visibleCalls.length > 0) {
      if (hasCompletedVisibleHeartbeatResponseToolCall(messages, index, visibleCalls)) {
        return undefined;
      }
    } else if (heartbeatCalls.length > 0) {
      sawTerminalHeartbeatArtifact = true;
      index = advancePastAdjacentToolResults(messages, index + 1);
      continue;
    } else if (
      !sawTerminalHeartbeatArtifact &&
      !isToolResultMessage(message) &&
      toolCalls.length === 0
    ) {
      if (message.role !== "assistant") {
        return undefined;
      }
      sawNonTerminalAssistantOutput = true;
    }
    index++;
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
  for (let i = 0; i < messages.length;) {
    const message = expectDefined(messages[i], "messages entry at i");
    const next = isHeartbeatUserMessage(message, heartbeatPrompt)
      ? resolveHeartbeatArtifactSpanEnd(messages, i, ackMaxChars)
      : undefined;
    if (next === undefined) {
      result.push(message);
    }
    i = next ?? i + 1;
  }

  return result;
}
