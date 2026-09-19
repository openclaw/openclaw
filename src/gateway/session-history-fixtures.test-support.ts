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

export async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const rawEvent = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const lines = rawEvent.split("\n");
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!data) {
        continue;
      }
      return { event, data: JSON.parse(data) };
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before next event");
    }
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}
