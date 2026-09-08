export function sparseAssistant(content: unknown[]) {
  return { role: "assistant" as const, content };
}

export function textToolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  fields?: { isError?: boolean },
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    ...fields,
  };
}

export function textAssistant(text: string): {
  role: "assistant";
  content: { type: "text"; text: string }[];
} {
  return { role: "assistant", content: [{ type: "text", text }] };
}
