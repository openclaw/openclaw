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

export type ChatInputHistoryKeyInput = {
  key: "ArrowUp" | "ArrowDown";
  selectionStart: number;
  selectionEnd: number;
  valueLength: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
};

export type ChatInputHistoryKeyResult = {
  handled: boolean;
  preventDefault: boolean;
  restoreCaret: "up" | "down" | null;
  decision:
    | "blocked:modifier-or-composition"
    | "blocked:selection-range"
    | "blocked:arrowup-not-at-start"
    | "blocked:arrowdown-editing-mode"
    | "blocked:history-boundary"
    | "handled:enter-history-up"
    | "handled:history-up"
    | "handled:history-down";
  historyNavigationActiveBefore: boolean;
  historyNavigationActiveAfter: boolean;
  selectionStart: number;
  selectionEnd: number;
  valueLength: number;
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

export function handleChatInputHistoryKey(
  state: ChatInputHistoryState,
  input: ChatInputHistoryKeyInput,
): ChatInputHistoryKeyResult {
  const historyNavigationActiveBefore = state.chatInputHistoryIndex !== -1;
  const baseResult = {
    historyNavigationActiveBefore,
    historyNavigationActiveAfter: historyNavigationActiveBefore,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    valueLength: input.valueLength,
  };

  if (
    input.altKey ||
    input.ctrlKey ||
    input.metaKey ||
    input.shiftKey ||
    input.isComposing ||
    input.keyCode === 229
  ) {
    return {
      ...baseResult,
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:modifier-or-composition",
    };
  }

  if (input.selectionStart !== input.selectionEnd) {
    return {
      ...baseResult,
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:selection-range",
    };
  }

  if (historyNavigationActiveBefore) {
    const direction = input.key === "ArrowUp" ? "up" : "down";
    const navigated = navigateChatInputHistory(state, direction);
    const historyNavigationActiveAfter = state.chatInputHistoryIndex !== -1;
    return {
      ...baseResult,
      handled: navigated,
      preventDefault: navigated,
      restoreCaret: navigated ? direction : null,
      decision: navigated
        ? direction === "up"
          ? "handled:history-up"
          : "handled:history-down"
        : "blocked:history-boundary",
      historyNavigationActiveAfter,
    };
  }

  if (input.key === "ArrowDown") {
    return {
      ...baseResult,
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:arrowdown-editing-mode",
    };
  }

  if (input.selectionStart !== 0) {
    return {
      ...baseResult,
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:arrowup-not-at-start",
    };
  }

  const navigated = navigateChatInputHistory(state, "up");
  const historyNavigationActiveAfter = state.chatInputHistoryIndex !== -1;
  return {
    ...baseResult,
    handled: navigated,
    preventDefault: navigated,
    restoreCaret: navigated ? "up" : null,
    decision: navigated ? "handled:enter-history-up" : "blocked:history-boundary",
    historyNavigationActiveAfter,
  };
}
