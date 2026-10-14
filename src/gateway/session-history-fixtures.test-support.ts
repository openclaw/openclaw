import { extractFirstTextBlock } from "../shared/chat-message-content.js";

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

export function createGatewayHistoryText(
  role: "user" | "assistant",
  text: unknown,
  timestamp: number,
) {
  return { role, content: [{ type: "text", text }], timestamp };
}

export function createGatewayHistoryMessageToolCall(
  id: string,
  args: Record<string, unknown>,
  timestamp: number,
) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "message", arguments: args }],
    timestamp,
  };
}

export function createGatewayHistoryMessageToolResult(
  id: string,
  content: unknown,
  timestamp: number,
) {
  return { role: "toolResult", toolName: "message", toolCallId: id, content, timestamp };
}

export function createGatewayHistoryDeliveryMirror(text: unknown, timestamp: number) {
  return {
    role: "assistant",
    provider: "openclaw",
    model: "delivery-mirror",
    content: [{ type: "text", text }],
    timestamp,
  };
}

export function hasGatewayHistoryMessageToolMirror(message: unknown) {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror,
  );
}

export function collectHistoryTextValues(historyMessages: unknown[]) {
  return historyMessages
    .map((message) => {
      if (message && typeof message === "object") {
        const entry = message as { text?: unknown };
        if (typeof entry.text === "string") {
          return entry.text;
        }
      }
      return extractFirstTextBlock(message);
    })
    .filter((value): value is string => typeof value === "string");
}
