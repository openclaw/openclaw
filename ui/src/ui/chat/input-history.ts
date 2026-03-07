import { CHAT_HISTORY_RENDER_LIMIT } from "./history-limits.ts";
import { extractText } from "./message-extract.ts";

export type ChatInputHistoryState = {
  sessionKey: string;
  chatMessage: string;
  chatMessages: unknown[];
  chatInputHistorySessionKey: string | null;
  chatInputHistoryItems: string[] | null;
  chatInputHistoryIndex: number;
  chatDraftBeforeHistory: string | null;
};

function collectUserInputHistory(messages: unknown[]): string[] {
  if (messages.length === 0) {
    return [];
  }
  // Keep input recall aligned with what chat UI renders: only consider the visible history window.
  const start = Math.max(0, messages.length - CHAT_HISTORY_RENDER_LIMIT);
  const items: string[] = [];
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as { role?: unknown };
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    if (role !== "user") {
      continue;
    }
    const text = extractText(message);
    if (!text || !text.trim()) {
      continue;
    }
    items.push(text);
  }
  return items;
}

export function resetChatInputHistoryNavigation(state: ChatInputHistoryState) {
  state.chatInputHistorySessionKey = null;
  state.chatInputHistoryItems = null;
  state.chatInputHistoryIndex = -1;
  state.chatDraftBeforeHistory = null;
}

export function handleChatDraftChange(state: ChatInputHistoryState, next: string) {
  state.chatMessage = next;
  resetChatInputHistoryNavigation(state);
}

function ensureChatInputHistorySnapshot(state: ChatInputHistoryState): string[] {
  if (
    Array.isArray(state.chatInputHistoryItems) &&
    state.chatInputHistorySessionKey === state.sessionKey
  ) {
    return state.chatInputHistoryItems;
  }
  // Snapshot once per navigation round so incoming chat events don't shift arrow-key traversal order.
  const items = collectUserInputHistory(state.chatMessages);
  state.chatInputHistoryItems = items;
  state.chatInputHistorySessionKey = state.sessionKey;
  state.chatInputHistoryIndex = -1;
  state.chatDraftBeforeHistory = state.chatMessage;
  return items;
}

export function navigateChatInputHistory(
  state: ChatInputHistoryState,
  direction: "up" | "down",
): boolean {
  const items = ensureChatInputHistorySnapshot(state);
  if (items.length === 0) {
    return false;
  }

  if (direction === "up") {
    if (state.chatInputHistoryIndex >= items.length - 1) {
      return false;
    }
    state.chatInputHistoryIndex += 1;
    state.chatMessage = items[state.chatInputHistoryIndex] ?? state.chatMessage;
    return true;
  }

  if (state.chatInputHistoryIndex === -1) {
    return false;
  }
  if (state.chatInputHistoryIndex === 0) {
    state.chatInputHistoryIndex = -1;
    state.chatMessage = state.chatDraftBeforeHistory ?? "";
    return true;
  }
  state.chatInputHistoryIndex -= 1;
  state.chatMessage = items[state.chatInputHistoryIndex] ?? state.chatMessage;
  return true;
}
