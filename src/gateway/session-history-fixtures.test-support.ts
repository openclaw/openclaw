export function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function assistantTextMessage(text: string, seq: number) {
  return {
    role: "assistant" as const,
    content: textContent(text),
    __openclaw: { seq },
  };
}

export function userTextMessage(text: string, seq: number) {
  return {
    role: "user" as const,
    content: textContent(text),
    __openclaw: { seq },
  };
}

export function messageToolCall(id: string, message: string, args: Record<string, unknown> = {}) {
  return {
    type: "toolCall" as const,
    id,
    name: "message",
    arguments: {
      action: "send",
      message,
      ...args,
    },
  };
}

export function messageToolResult(
  toolCallId: string,
  messageId: string,
  seq?: number,
  content: Record<string, unknown> = {},
) {
  return {
    role: "toolResult" as const,
    toolName: "message",
    toolCallId,
    content: { ok: true, messageId, ...content },
    ...(seq === undefined ? {} : { __openclaw: { seq } }),
  };
}
