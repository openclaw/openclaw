import type { Api, Context, Model } from "@mariozechner/pi-ai";

type PendingToolCall = { id: string; name: string };
type AssistantToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
  thoughtSignature?: string;
};
type TransformableAssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | AssistantToolCallBlock
  | { type: "compaction"; content: string | null };
type TransformableAssistantMessage = Omit<
  Extract<Context["messages"][number], { role: "assistant" }>,
  "content"
> & {
  content: TransformableAssistantContentBlock[] | string;
};

function appendMissingToolResults(
  result: Context["messages"],
  pendingToolCalls: PendingToolCall[],
  existingToolResultIds: ReadonlySet<string>,
): void {
  for (const toolCall of pendingToolCalls) {
    if (!existingToolResultIds.has(toolCall.id)) {
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
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
    const assistantMessage = msg as TransformableAssistantMessage;
    const isSameModel =
      assistantMessage.provider === model.provider &&
      assistantMessage.api === model.api &&
      assistantMessage.model === model.id;
    const content: TransformableAssistantContentBlock[] = [];
    const assistantContent =
      typeof assistantMessage.content === "string"
        ? [{ type: "text" as const, text: assistantMessage.content }]
        : assistantMessage.content;
    for (const block of assistantContent) {
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
      let normalizedToolCall: AssistantToolCallBlock = {
        ...block,
      };
      if (!isSameModel && block.thoughtSignature) {
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.thoughtSignature;
      }
      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(block.id, model, assistantMessage);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    return { ...assistantMessage, content } as unknown as Context["messages"][number];
  });

  const result: Context["messages"] = [];
  let pendingToolCalls: PendingToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        appendMissingToolResults(result, pendingToolCalls, existingToolResultIds);
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const toolCalls = msg.content.filter(
        (block): block is Extract<(typeof msg.content)[number], { type: "toolCall" }> =>
          block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls.map((block) => ({ id: block.id, name: block.name }));
        existingToolResultIds = new Set();
      }
      result.push(msg);
      continue;
    }
    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }
    if (pendingToolCalls.length > 0) {
      appendMissingToolResults(result, pendingToolCalls, existingToolResultIds);
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(msg);
  }
  return result;
}
