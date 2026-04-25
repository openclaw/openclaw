export function normalizeContextMessages(messages: unknown[]) {
  const out: unknown[] = [];

  for (const m of messages) {
    const msg = m as {
      role: string;
      toolCallId?: string;
      id?: string;
      content: unknown;
      toolCalls?: unknown;
      tool_calls?: unknown;
    };

    if (msg.role === "toolResult") {
      out.push({
        role: "tool",
        tool_call_id:
          msg.toolCallId || msg.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? {}),
      });
      continue;
    }

    if (msg.role === "assistant" && (msg.toolCalls || msg.tool_calls)) {
      out.push({
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
        tool_calls: msg.toolCalls || msg.tool_calls,
      });
      continue;
    }

    out.push({
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : (Array.isArray(msg.content) ? msg.content : [])
              .map((c: unknown) => {
                const block = c as { type?: string; text?: string };
                return block.type === "text" ? (block.text ?? "") : "";
              })
              .join("\n"),
    });
  }

  return out;
}

export function buildOpenAITools(tools: unknown[]) {
  return tools.map((t) => {
    const tool = t as { name: string; description?: string; parameters?: unknown };
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || {
          type: "object",
          properties: {},
        },
      },
    };
  });
}

export function safeJsonParse(input: unknown): unknown {
  if (!input) {
    return {};
  }

  if (typeof input === "object") {
    return input;
  }

  if (typeof input !== "string") {
    return {};
  }

  try {
    return JSON.parse(input);
  } catch {
    // 🔥 WICHTIG: fallback für kaputtes JSON vom LLM
    try {
      return JSON.parse(input.trim());
    } catch {
      return {};
    }
  }
}
