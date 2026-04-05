import { extractTextFromChatContent } from "../../shared/chat-content.js";

export type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const role = (msg as { role?: unknown }).role;
    return role !== "toolResult" && role !== "tool";
  });
}

function sanitizeAssistantText(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(/\[Tool Call:[^\]]+\]\s*/g, "").replace(/\s+/g, " ").trim();
}

export function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  const shouldSanitize = role === "assistant";
  const text = extractTextFromChatContent(message.content, {
    sanitizeText: shouldSanitize ? sanitizeAssistantText : undefined,
  });
  return text ? { role, text } : null;
}

export function formatLogLines(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const msg of messages) {
    const extracted = extractMessageText(msg);
    if (!extracted) {
      continue;
    }
    const label = extracted.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${extracted.text}`);
  }
  return lines;
}
