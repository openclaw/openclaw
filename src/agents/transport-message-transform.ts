import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { repairToolUseResultPairing } from "./session-transcript-repair.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

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
const log = createSubsystemLogger("agents/transport-message-transform");

/**
 * PR-9 Wave C-#1b: structured placeholder text used when a tool_use
 * has no matching tool_result at transport-assembly time. Carries
 * enough context (toolName + toolCallId) for the agent's read-time
 * context to surface a real diagnosis, AND a `[transport-repair]`
 * marker so log triage / Eva's transcript-anomaly heuristics can
 * distinguish "the tool actually failed" from "the result was lost
 * during reconstruction." Replaces the prior bare `"No result
 * provided"` string which was indistinguishable from a real failure
 * (Eva's reliability handoff #1b).
 */
function buildMissingToolResultText(toolCall: PendingToolCall): string {
  return [
    `[transport-repair] tool_use "${toolCall.name}" (id=${toolCall.id}) had no paired`,
    "tool_result at transport-assembly time. The original result was likely lost",
    "during session-history reconstruction (crash before disk flush, history",
    "compaction that dropped the pairing, or replay drift). This is a transport",
    "repair placeholder, NOT evidence that the tool itself failed — check the",
    "live agent logs and gateway transcript for the original result.",
  ].join(" ");
}

function appendMissingToolResults(
  result: Context["messages"],
  pendingToolCalls: PendingToolCall[],
  existingToolResultIds: ReadonlySet<string>,
): void {
  for (const toolCall of pendingToolCalls) {
    if (!existingToolResultIds.has(toolCall.id)) {
      // PR-9 Wave C-#1b: log the repair so operators can grep
      // `transport-repair` in gateway logs to find the originating
      // session+turn. The placeholder text already includes the same
      // marker so it's discoverable from both sides.
      log.warn(
        `transport-repair: synthesized placeholder for unpaired tool_use ` +
          `name=${toolCall.name} id=${toolCall.id}`,
      );
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: buildMissingToolResultText(toolCall) }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
  return message.stopReason === "error" || message.stopReason === "aborted";
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

  if (!allowSyntheticToolResults) {
    return replayable;
  }

  // PI's local transform can synthesize missing results, but it does not move
  // displaced real results back before an intervening user turn. Shared repair
  // handles both, while preserving the previous transport behavior of dropping
  // aborted/error assistant tool-call turns before replaying strict providers.
  return repairToolUseResultPairing(replayable, {
    erroredAssistantResultPolicy: "drop",
    missingToolResultText: syntheticToolResultText,
  }).messages as Context["messages"];
}
