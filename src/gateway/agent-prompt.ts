import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

export type ConversationEntry = {
  role: "user" | "assistant" | "tool";
  entry: HistoryEntry;
};

/**
 * Coerce body to string. Handles cases where body is a content array
 * (e.g. [{type:"text", text:"hello"}]) that would serialize as
 * [object Object] if used directly in a template literal.
 */
function safeBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  return extractTextFromChatContent(body) ?? "";
}

export function buildAgentMessageFromConversationEntries(entries: ConversationEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  // Prefer the last user/tool entry as "current message" so the agent responds to
  // the latest user input or tool output, not the assistant's previous message.
  let currentIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const role = entries[i]?.role;
    if (role === "user" || role === "tool") {
      currentIndex = i;
      break;
    }
  }
  if (currentIndex < 0) {
    currentIndex = entries.length - 1;
  }

  const currentEntry = entries[currentIndex]?.entry;
  if (!currentEntry) {
    return "";
  }

  const historyEntries = entries.slice(0, currentIndex).map((e) => e.entry);
  if (historyEntries.length === 0) {
    return safeBody(currentEntry.body);
  }

  const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${safeBody(entry.body)}`;
  return buildHistoryContextFromEntries({
    entries: [...historyEntries, currentEntry],
    currentMessage: formatEntry(currentEntry),
    formatEntry,
  });
}
