// Gateway agent prompt builder.
// Converts conversation entries into the latest-message-plus-history prompt.
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { buildHistoryContext, type HistoryEntry } from "../auto-reply/reply/history.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

export type ConversationEntry = {
  role: "user" | "assistant" | "tool";
  entry: HistoryEntry;
  internalStreamError?: boolean;
};

export type ConversationToolCall = { id?: string; name: string; arguments: string };

export function renderConversationToolCall(call: ConversationToolCall): string {
  return `tool_call id=${call.id ?? ""} name=${call.name} arguments=${call.arguments}`;
}

// Placeholder user text for an image-only turn. The agent command requires a
// non-empty message even when the real payload is the attached image, so both
// the /v1/chat/completions and /v1/responses prompt builders substitute this
// for the active user turn. Keep it shared so the two endpoints stay in sync.
export const IMAGE_ONLY_USER_MESSAGE = "User sent image(s) with no text.";

/** Normalize content-array bodies and omit provenance-marked stream-error placeholders. */
function toPromptBody(entry: ConversationEntry): string | null {
  const raw = entry.entry.body;
  const body = typeof raw === "string" ? raw : (extractTextFromChatContent(raw) ?? "");
  return entry.role === "assistant" &&
    entry.internalStreamError === true &&
    body.trim() === STREAM_ERROR_FALLBACK_TEXT
    ? null
    : body;
}

/** Build the prompt text sent to an agent from ordered conversation entries. */
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

  const currentConversationEntry = entries[currentIndex];
  const currentEntry = currentConversationEntry?.entry;
  if (!currentConversationEntry || !currentEntry) {
    return "";
  }

  const historyLines: string[] = [];
  // Both HTTP adapters construct dense entries before selecting the current turn.
  for (let index = 0; index < currentIndex; index += 1) {
    const entry = entries[index]!;
    const body = toPromptBody(entry);
    if (body !== null) {
      historyLines.push(`${entry.entry.sender}: ${body}`);
    }
  }
  const currentBody = toPromptBody(currentConversationEntry);
  if (currentBody === null) {
    return "";
  }
  // A completed tool call still needs its identity when its output is empty.
  if (historyLines.length === 0 && currentConversationEntry.role !== "tool") {
    return currentBody;
  }

  return buildHistoryContext({
    historyText: historyLines.join("\n"),
    currentMessage: `${currentEntry.sender}: ${currentBody}`,
  });
}
