import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { extractText } from "../../lib/chat/message-extract.ts";

const CHAT_INPUT_HISTORY_LIMIT = 100;

type ChatLocalInputHistoryEntry = {
  text: string;
  ts: number;
};

export type ChatInputHistoryState = {
  sessionKey: string;
  chatLoading: boolean;
  chatMessage: string;
  chatMentions?: readonly HumanMention[];
  chatMessages: unknown[];
  chatLocalInputHistoryBySession: Record<string, ChatLocalInputHistoryEntry[]>;
  chatInputHistorySessionKey: string | null;
  chatInputHistoryItems: string[] | null;
  chatInputHistoryIndex: number;
  chatDraftBeforeHistory: string | null;
  chatMentionsBeforeHistory?: readonly HumanMention[];
};

export type ChatInputHistoryKeyInput = {
  key: "ArrowUp" | "ArrowDown";
  selectionStart: number;
  selectionEnd: number;
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
};

function collectUserInputHistory(
  messages: unknown[],
  localEntries: ChatLocalInputHistoryEntry[],
): string[] {
  // Bound input recall independently from the transcript's loaded rendering depth.
  const start = Math.max(0, messages.length - CHAT_INPUT_HISTORY_LIMIT);
  const candidates: Array<{ text: string; ts: number }> = [...localEntries];
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }
    const entry = message as { role?: unknown; timestamp?: unknown };
    const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    if (role !== "user") {
      continue;
    }
    const text = extractText(message);
    if (!text || !text.trim()) {
      continue;
    }
    candidates.push({ text, ts: typeof entry.timestamp === "number" ? entry.timestamp : 0 });
  }

  candidates.sort((a, b) => b.ts - a.ts);
  return [...new Set(candidates.map(({ text }) => text))];
}

export function recordNonTranscriptInputHistory(state: ChatInputHistoryState, text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const sessionEntries = state.chatLocalInputHistoryBySession[state.sessionKey] ?? [];
  if (sessionEntries[0]?.text === trimmed) {
    return;
  }
  state.chatLocalInputHistoryBySession[state.sessionKey] = [
    { text: trimmed, ts: Date.now() },
    ...sessionEntries,
  ].slice(0, CHAT_INPUT_HISTORY_LIMIT);
}

export function resetChatInputHistoryNavigation(state: ChatInputHistoryState) {
  state.chatInputHistorySessionKey = null;
  state.chatInputHistoryItems = null;
  state.chatInputHistoryIndex = -1;
  state.chatDraftBeforeHistory = null;
  state.chatMentionsBeforeHistory = undefined;
}

export function handleChatDraftChange(
  state: ChatInputHistoryState,
  next: string,
  mentions?: readonly HumanMention[],
) {
  state.chatMentions = mentions ?? updateHumanMentions(state.chatMessage, next, state.chatMentions);
  state.chatMessage = next;
  resetChatInputHistoryNavigation(state);
}

function ensureChatInputHistorySnapshot(state: ChatInputHistoryState): string[] {
  if (
    state.chatInputHistoryItems !== null &&
    state.chatInputHistorySessionKey === state.sessionKey
  ) {
    return state.chatInputHistoryItems;
  }
  // Snapshot once per navigation round so incoming chat events don't shift arrow-key traversal order.
  const items = collectUserInputHistory(
    state.chatMessages,
    state.chatLocalInputHistoryBySession[state.sessionKey] ?? [],
  );
  state.chatInputHistoryItems = items;
  state.chatInputHistorySessionKey = state.sessionKey;
  state.chatInputHistoryIndex = -1;
  state.chatDraftBeforeHistory = state.chatMessage;
  state.chatMentionsBeforeHistory = state.chatMentions;
  return items;
}

function navigateChatInputHistory(state: ChatInputHistoryState, direction: "up" | "down"): boolean {
  const items = ensureChatInputHistorySnapshot(state);
  if (items.length === 0) {
    return false;
  }

  const nextIndex = state.chatInputHistoryIndex + (direction === "up" ? 1 : -1);
  if (nextIndex < -1 || nextIndex >= items.length) {
    return false;
  }
  state.chatInputHistoryIndex = nextIndex;
  state.chatMessage =
    nextIndex === -1
      ? (state.chatDraftBeforeHistory ?? "")
      : (items[nextIndex] ?? state.chatMessage);
  state.chatMentions = nextIndex === -1 ? state.chatMentionsBeforeHistory : [];
  return true;
}

export function handleChatInputHistoryKey(
  state: ChatInputHistoryState,
  input: ChatInputHistoryKeyInput,
): ChatInputHistoryKeyResult {
  // Programmatic draft updates can bypass handleChatDraftChange(); if the current
  // draft no longer matches the active recalled item, drop back to editing mode.
  if (
    state.chatInputHistoryIndex !== -1 &&
    (state.chatInputHistorySessionKey !== state.sessionKey ||
      state.chatInputHistoryItems?.[state.chatInputHistoryIndex] !== state.chatMessage)
  ) {
    resetChatInputHistoryNavigation(state);
  }
  if (
    state.chatLoading ||
    input.altKey ||
    input.ctrlKey ||
    input.metaKey ||
    input.shiftKey ||
    input.isComposing ||
    input.keyCode === 229 ||
    input.selectionStart !== input.selectionEnd ||
    (state.chatInputHistoryIndex === -1 &&
      (input.key === "ArrowDown" || input.selectionStart !== 0))
  ) {
    return { handled: false, preventDefault: false, restoreCaret: null };
  }

  const direction = input.key === "ArrowUp" ? "up" : "down";
  const navigated = navigateChatInputHistory(state, direction);
  return {
    handled: navigated,
    preventDefault: navigated,
    restoreCaret: navigated ? direction : null,
  };
}
