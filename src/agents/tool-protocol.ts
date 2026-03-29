export function normalizeContextMessages(messages: any[]) {
  const out: any[] = [];

  for (const m of messages) {
    if (m.role === "toolResult") {
      out.push({
        role: "tool",
        tool_call_id:
          m.toolCallId ||
          m.id ||
          `tool_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? {}),
      });
      continue;
    }

    if (m.role === "assistant" && (m.toolCalls || m.tool_calls)) {
      out.push({
        role: "assistant",
        content: typeof m.content === "string" ? m.content : "",
        tool_calls: m.toolCalls || m.tool_calls,
      });
      continue;
    }

    out.push({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : (m.content || [])
              .map((c: any) => (c.type === "text" ? c.text : ""))
              .join("\n"),
    });
  }

  return out;
}

export function buildOpenAITools(tools: any[]) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || {
        type: "object",
        properties: {},
      },
    },
  }));
}

export function safeJsonParse(input: string | undefined) {
  if (!input) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}