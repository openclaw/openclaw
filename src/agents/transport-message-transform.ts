/**
 * Normalizes transcript messages before provider transport replay. It drops
 * unsafe failed turns, maps tool-call ids across model boundaries, and fills
 * strict provider tool-result gaps when supported.
 */
import type { AiTransformTransportMessages } from "@openclaw/ai";
import { prepareModelBoundThinkingReplay } from "@openclaw/ai/internal/anthropic";
import { OPENAI_RESPONSES_APIS } from "@openclaw/ai/internal/openai-responses-payload-policy";
import {
  FAILED_ASSISTANT_REPLAY_TEXT,
  isReasoningOnlyLengthAssistantTurn,
  resolveFailedAssistantReplay,
} from "@openclaw/ai/internal/shared";
import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { Context } from "../llm/types.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

const SYNTHETIC_TOOL_RESULT_APIS = new Set<string>([
  "anthropic-messages",
  "openclaw-anthropic-messages-transport",
  "bedrock-converse-stream",
  "google-generative-ai",
  "openclaw-google-generative-ai-transport",
  ...OPENAI_RESPONSES_APIS,
]);

// Responses-family APIs retain their inherited "aborted" synthetic-result convention.
export function transformTransportMessages(
  messages: Parameters<AiTransformTransportMessages>[0],
  model: Parameters<AiTransformTransportMessages>[1],
  normalizeToolCallId?: Parameters<AiTransformTransportMessages>[2],
  options?: Parameters<AiTransformTransportMessages>[3],
): Context["messages"] {
  const syntheticToolResultText = OPENAI_RESPONSES_APIS.has(model.api)
    ? "aborted"
    : DEFAULT_MISSING_TOOL_RESULT_TEXT;
  const toolCallIdMap = new Map<string, string>();
  const thinkingReplay = prepareModelBoundThinkingReplay(model);
  let hasCrossModelAsyncCalls = false;
  const transformed = messages.map((msg) => {
    if (msg.role === "toolResult") {
      // Earlier history repair may already have paired this call. Apply the same
      // transport placeholder without rewriting persisted diagnostics or real output.
      const normalizeRepairText =
        isSyntheticMissingToolResult(msg) &&
        (msg.content.length !== 1 ||
          msg.content[0]?.type !== "text" ||
          msg.content[0].text !== syntheticToolResultText);
      const result = normalizeRepairText
        ? {
            ...msg,
            content: [{ type: "text" as const, text: syntheticToolResultText }],
            // Legacy placeholders were identified by prose alone. Preserve their
            // provenance so pairing can still replace them with a later real result.
            details: {
              ...(isRecord(msg.details) ? msg.details : {}),
              [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true,
            },
          }
        : msg;
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId
        ? { ...result, toolCallId: normalizedId }
        : result;
    }
    if (msg.role !== "assistant") {
      return msg;
    }
    const modelBoundThinkingReplayMode = thinkingReplay({
      provider: msg.provider,
      api: msg.api,
      modelId: msg.model,
      responseModelId: msg.responseModel,
    });
    const isSameModel =
      modelBoundThinkingReplayMode === "preserve" ||
      (msg.provider === model.provider && msg.api === model.api && msg.model === model.id);
    const sourceContent = Array.isArray(msg.content)
      ? msg.content
      : msg.content != null && typeof msg.content === "object"
        ? ([msg.content] as typeof msg.content)
        : [];
    const content: typeof msg.content = [];
    for (const block of sourceContent) {
      if (block.type === "thinking") {
        if (modelBoundThinkingReplayMode === "drop") {
          continue;
        }
        if (
          block.redacted
            ? isSameModel
            : (isSameModel && block.thinkingSignature) || block.thinking.trim()
        ) {
          content.push(isSameModel ? block : { type: "text", text: block.thinking });
        }
        continue;
      }
      if (block.type === "text") {
        content.push(isSameModel ? block : { type: "text", text: block.text });
        continue;
      }
      if (block.type !== "toolCall") {
        content.push(block);
        continue;
      }
      let normalizedToolCall = block;
      if (!isSameModel && block.async) {
        hasCrossModelAsyncCalls = true;
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.async;
      }
      if (
        !isSameModel &&
        block.thoughtSignature &&
        options?.preserveCrossModelToolCallThoughtSignature !== true
      ) {
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.thoughtSignature;
      }
      if (
        (!isSameModel || options?.normalizeSameModelToolCallIds === true) &&
        normalizeToolCallId
      ) {
        const normalizedId = normalizeToolCallId(block.id, model, msg);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    // Mutable replay callers still own a detached shell and content array.
    return Array.isArray(msg.content) &&
      Object.isFrozen(msg) &&
      Object.isFrozen(msg.content) &&
      content.length === msg.content.length &&
      content.every((block, index) => block === msg.content[index])
      ? msg
      : { ...msg, content };
  });
  // Pairing-aware transports must let shared repair see errored tool-call frames and
  // their adjacent results together; pre-filtering the call can misattribute its result
  // to an older turn that reused the same provider id.
  const requiresPairing = SYNTHETIC_TOOL_RESULT_APIS.has(model.api) || hasCrossModelAsyncCalls;
  let replayLength = 0;
  transformed.forEach((msg, index) => {
    const original = messages[index];
    if (original && isReasoningOnlyLengthAssistantTurn(original)) {
      return;
    }
    const replay = original
      ? resolveFailedAssistantReplay(original, { pairingAware: requiresPairing })
      : "keep";
    if (replay !== "drop") {
      transformed[replayLength++] =
        replay === "marker"
          ? { ...msg, content: [{ type: "text", text: FAILED_ASSISTANT_REPLAY_TEXT }] }
          : msg;
    }
  });
  transformed.length = replayLength;

  if (!requiresPairing) {
    return transformed;
  }

  // The local transport transform can synthesize missing results, but it does not move
  // displaced real results back before an intervening user turn. Shared repair
  // handles both and drops aborted/error turns together with their owned results.
  return sanitizeToolUseResultPairing(transformed, {
    erroredAssistantResultPolicy: "drop",
    missingToolResultText: syntheticToolResultText,
    preserveUnframedToolResults: options?.preserveUnframedToolResults,
  }) as Context["messages"];
}
