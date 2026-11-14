export function recordedToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}
