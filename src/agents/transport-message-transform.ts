import type { Api, Context, Model } from "@mariozechner/pi-ai";

// Tool names that fetch external network content. Their text results are wrapped
// in <tool_result trusted="false"> delimiters so the model treats them as data,
// not as instructions. Lowercase, matching normalizeToolName output.
const OPEN_WORLD_TOOL_NAMES = new Set(["web_fetch", "web_search", "x_search"]);

function isOpenWorldToolResult(msg: {
  toolName: string;
  details?: unknown;
  isError: boolean;
}): boolean {
  // Error payloads are framework-generated text, not external content.
  if (msg.isError) {
    return false;
  }
  if (OPEN_WORLD_TOOL_NAMES.has(msg.toolName.trim().toLowerCase())) {
    return true;
  }
  // External MCP tools carry mcpServer or mcpTool in their details object.
  const details = msg.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    if (typeof d.mcpServer === "string" || typeof d.mcpTool === "string") {
      return true;
    }
  }
  return false;
}

type ToolResultContent = Extract<Context["messages"][number], { role: "toolResult" }>["content"];

function wrapToolResultContentForTrust(
  toolName: string,
  content: ToolResultContent,
): ToolResultContent {
  const source = toolName.trim().toLowerCase();
  return content.map((block) => {
    if (block.type !== "text") {
      return block;
    }
    const text = block.text.trim();
    if (!text) {
      return block;
    }
    return {
      ...block,
      text: `<tool_result source="${source}" trusted="false">\n${block.text}\n</tool_result>`,
    };
  });
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
      const idNormalized =
        normalizedId && normalizedId !== msg.toolCallId
          ? { ...msg, toolCallId: normalizedId }
          : msg;
      if (isOpenWorldToolResult(idNormalized)) {
        return {
          ...idNormalized,
          content: wrapToolResultContentForTrust(idNormalized.toolName, idNormalized.content),
        };
      }
      return idNormalized;
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

  const result: Context["messages"] = [];
  let pendingToolCalls: Array<{ id: string; name: string }> = [];
  let existingToolResultIds = new Set<string>();
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
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
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(msg);
  }
  return result;
}
