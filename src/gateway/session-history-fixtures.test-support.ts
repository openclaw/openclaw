import { extractFirstTextBlock } from "../shared/chat-message-content.js";

export const textContent = (text: string) => [{ type: "text" as const, text }];

export const assistantTextMessage = (text: string, seq: number) =>
  sequencedText("assistant", text, seq);

export const userTextMessage = (text: string, seq: number) => sequencedText("user", text, seq);

function sequencedText<Role extends "assistant" | "user">(role: Role, text: string, seq: number) {
  return { role, content: textContent(text), __openclaw: { seq } };
}

export function messageToolCall(id: string, message: string, args: Record<string, unknown> = {}) {
  const input = { action: "send", message, ...args };
  return { type: "toolCall" as const, id, name: "message", arguments: input };
}

export async function readSseEvent(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  state: { buffer: string },
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const lines = state.buffer.slice(0, boundary).split("\n");
      state.buffer = state.buffer.slice(boundary + 2);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) {
        continue;
      }
      return { event: eventLine?.slice(6).trim() ?? "message", data: JSON.parse(data) };
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before next event");
    }
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

export const createGatewayHistoryText = (
  role: "user" | "assistant",
  text: unknown,
  timestamp: number,
) => ({ role, content: [{ type: "text", text }], timestamp });

export const createGatewayHistoryMessageToolCall = (
  id: string,
  args: Record<string, unknown>,
  timestamp: number,
) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "message", arguments: args }],
  timestamp,
});

export const createGatewayHistoryMessageToolResult = (
  id: string,
  content: unknown,
  timestamp: number,
) => ({ role: "toolResult", toolName: "message", toolCallId: id, content, timestamp });

export const createGatewayHistoryDeliveryMirror = (text: unknown, timestamp: number) => ({
  role: "assistant",
  provider: "openclaw",
  model: "delivery-mirror",
  content: [{ type: "text", text }],
  timestamp,
});

export const hasGatewayHistoryMessageToolMirror = (message: unknown) =>
  Boolean(
    message &&
    typeof message === "object" &&
    (message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror,
  );

export function collectHistoryTextValues(historyMessages: unknown[]) {
  return historyMessages
    .map((message) => {
      const text =
        message && typeof message === "object" ? (message as { text?: unknown }).text : undefined;
      return typeof text === "string" ? text : extractFirstTextBlock(message);
    })
    .filter((value): value is string => typeof value === "string");
}
