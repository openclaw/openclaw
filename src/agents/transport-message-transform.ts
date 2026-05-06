import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { repairToolUseResultPairing } from "./session-transcript-repair.js";

const SYNTHETIC_TOOL_RESULT_APIS = new Set<string>([
  "anthropic-messages",
  "openclaw-anthropic-messages-transport",
  "bedrock-converse-stream",
  "google-generative-ai",
  "openclaw-google-generative-ai-transport",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);

// "aborted" is an OpenAI Responses-family convention from upstream Codex
// history normalization. Gemini/Anthropic transports use their own text while
// still needing synthetic results to satisfy provider turn-shape contracts;
// tool-replay-repair.live.test.ts exercises both paths against real models.
const CODEX_STYLE_ABORTED_OUTPUT_APIS = new Set<string>([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "openclaw-openai-responses-transport",
  "openclaw-azure-openai-responses-transport",
]);

function defaultAllowSyntheticToolResults(modelApi: Api): boolean {
  return SYNTHETIC_TOOL_RESULT_APIS.has(modelApi);
}

function isFailedAssistantTurn(message: Context["messages"][number]): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  return message.stopReason === "error" || message.stopReason === "aborted";
}

/**
 * Detects identical thinking blocks across consecutive assistant turns that
 * also contain tool calls, and injects a loop-breaker user message if found.
 *
 * Exported so both the responses transport (`transformTransportMessages`) and
 * the completions transport (`buildOpenAICompletionsParams`) can wire it in.
 * (#73781)
 */
export function injectLoopHintIfNeeded(msgs: Context["messages"]): Context["messages"] {
  // Walk turns to find consecutive assistant turns with tool calls
  // whose thinking blocks are identical.
  const turns: { thinking: string; hasToolCalls: boolean }[] = [];
  for (const msg of msgs) {
    if (msg.role === "assistant" && msg.content) {
      let thinking = "";
      let hasToolCalls = false;
      for (const block of msg.content) {
        if (block.type === "thinking" && typeof block.thinking === "string") {
          thinking = block.thinking.trim();
        } else if (block.type === "toolCall") {
          hasToolCalls = true;
        }
      }
      if (thinking) {
        turns.push({ thinking, hasToolCalls });
      }
    }
  }
  // Require 3 consecutive assistant turns with tool calls AND identical thinking
  const needed = 3;
  if (turns.length >= needed) {
    const last = turns.at(-1);
    const middle = turns.at(-2);
    const first = turns.at(-3);
    if (
      last && middle && first &&
      last.thinking === middle.thinking &&
      last.thinking === first.thinking &&
      last.hasToolCalls && middle.hasToolCalls && first.hasToolCalls
    ) {
      const out = [...msgs, {
        role: "user" as const,
        content: [{
          type: "text" as const,
          text:
            "⚠️ [LOOP DETECTED] Your last 3 thinking blocks are identical and " +
            "all included tool calls. Tool results are already available — analyze " +
            "them instead of repeating the same reasoning. If the task is done, " +
            "provide a final response.",
        }],
        timestamp: Date.now(),
      }];
      return out;
    }
  }
  return msgs;
}

export function transformTransportMessages(
  messages: Context["messages"],
  model: Model<Api>,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model<Api>,
    source: { provider: string; api: Api; model: string },
  ) => string,
): Context["messages"] {
  const allowSyntheticToolResults = defaultAllowSyntheticToolResults(model.api);
  const syntheticToolResultText = CODEX_STYLE_ABORTED_OUTPUT_APIS.has(model.api)
    ? "aborted"
    : "No result provided";
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId
        ? { ...msg, toolCallId: normalizedId }
        : msg;
    }
    if (msg.role !== "assistant") {
      return msg;
    }
    const isSameModel =
      msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const content: typeof msg.content = [];
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) {
            content.push(block);
          }
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          content.push(block);
          continue;
        }
        if (!block.thinking.trim()) {
          continue;
        }
        content.push(isSameModel ? block : { type: "text", text: block.thinking });
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
      if (!isSameModel && block.thoughtSignature) {
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.thoughtSignature;
      }
      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(block.id, model, msg);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    return { ...msg, content };
  });

  // Preserve the old transport replay filter: failed streamed turns can contain
  // partial text, partial tool calls, or both, and strict providers can treat
  // them as valid assistant context on retry unless we drop the whole turn.
  const replayable = transformed.filter((msg) => !isFailedAssistantTurn(msg));
  // Run loop hint detection on all transports (including non-synthetic ones like
  // openai-completions used by Qwen) before the early return below.
  const withHint = injectLoopHintIfNeeded(replayable);
  if (!allowSyntheticToolResults) {
    return withHint;
  }

  // PI's local transform can synthesize missing results, but it does not move
  // displaced real results back before an intervening user turn. Shared repair
  // handles both, while preserving the previous transport behavior of dropping
  // aborted/error assistant tool-call turns before replaying strict providers.
  return repairToolUseResultPairing(withHint, {
    erroredAssistantResultPolicy: "drop",
    missingToolResultText: syntheticToolResultText,
  }).messages as Context["messages"];
}
