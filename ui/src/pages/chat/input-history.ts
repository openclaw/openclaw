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
  completion?: Promise<ChatInputHistoryKeyResult>;
};

export type ChatInputHistoryReader = () => Promise<
  { messages?: unknown[]; hasMore: boolean } | undefined
>;

type ChatInputHistoryReaderFactory = () => ChatInputHistoryReader | undefined;

type ChatInputHistoryRound = {
  createReader?: ChatInputHistoryReaderFactory;
  read?: ChatInputHistoryReader;
  exhausted: boolean;
  revision: number;
  pending?: Promise<ChatInputHistoryKeyResult>;
};

const inputHistoryRounds = new WeakMap<string[], ChatInputHistoryRound>();

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

function ensureChatInputHistorySnapshot(
  state: ChatInputHistoryState,
  createReader?: ChatInputHistoryReaderFactory,
): string[] {
  if (
    state.chatInputHistoryItems !== null &&
    (state.chatInputHistoryIndex !== -1 ||
      inputHistoryRounds.get(state.chatInputHistoryItems)?.pending !== undefined) &&
    state.chatInputHistorySessionKey === state.sessionKey
  ) {
    return state.chatInputHistoryItems;
  }
  // Snapshot once per navigation round so incoming chat events don't shift arrow-key traversal order.
  const messages = state.chatMessages;
  const localEntries = state.chatLocalInputHistoryBySession[state.sessionKey] ?? [];
  // Assistant/tool activity must not evict the user inputs it answered.
  const candidates: Array<{ text: string; ts: number }> = [...localEntries];
  let transcriptInputs = 0;
  for (let i = messages.length - 1; i >= 0 && transcriptInputs < CHAT_INPUT_HISTORY_LIMIT; i--) {
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
    transcriptInputs += 1;
  }

  candidates.sort((a, b) => b.ts - a.ts);
  const items = [...new Set(candidates.map(({ text }) => text))].slice(0, CHAT_INPUT_HISTORY_LIMIT);
  state.chatInputHistoryItems = items;
  inputHistoryRounds.set(items, {
    createReader,
    read: createReader?.(),
    exhausted: false,
    revision: 0,
  });
  state.chatInputHistorySessionKey = state.sessionKey;
  state.chatInputHistoryIndex = -1;
  state.chatDraftBeforeHistory = state.chatMessage;
  state.chatMentionsBeforeHistory = state.chatMentions;
  return items;
}

function navigateChatInputHistory(
  state: ChatInputHistoryState,
  direction: "up" | "down",
  createReader?: ChatInputHistoryReaderFactory,
): boolean {
  const items = ensureChatInputHistorySnapshot(state, createReader);
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
  const round = inputHistoryRounds.get(items);
  if (round) {
    round.revision += 1;
  }
  return true;
}

function loadOlderChatInputHistory(
  state: ChatInputHistoryState,
  items: string[],
  round: ChatInputHistoryRound,
): Promise<ChatInputHistoryKeyResult> {
  const sessionKey = state.sessionKey;
  const index = state.chatInputHistoryIndex;
  const draft = state.chatMessage;
  const revision = round.revision;
  const unhandled: ChatInputHistoryKeyResult = {
    handled: false,
    preventDefault: false,
    restoreCaret: null,
  };
  const isCurrent = () =>
    state.sessionKey === sessionKey && state.chatInputHistoryItems === items && !state.chatLoading;

  const pending = (async (): Promise<ChatInputHistoryKeyResult> => {
    while (round.read && items.length < CHAT_INPUT_HISTORY_LIMIT) {
      const page = await round.read();
      if (!isCurrent()) {
        return unhandled;
      }
      if (!page) {
        // A reconnect retires the reader, not the saved draft or navigation round.
        round.read = undefined;
        return unhandled;
      }

      const known = new Set(items);
      const messages = page.messages ?? [];
      for (let i = messages.length - 1; i >= 0 && items.length < CHAT_INPUT_HISTORY_LIMIT; i--) {
        const message = messages[i];
        if (!message || typeof message !== "object") {
          continue;
        }
        const entry = message as { role?: unknown };
        if (typeof entry.role !== "string" || entry.role.toLowerCase() !== "user") {
          continue;
        }
        const text = extractText(message);
        if (!text?.trim() || known.has(text)) {
          continue;
        }
        known.add(text);
        items.push(text);
      }
      if (!page.hasMore) {
        round.exhausted = true;
        round.read = undefined;
      }
      if (items.length > index + 1) {
        break;
      }
    }

    const next = items[index + 1];
    if (
      !isCurrent() ||
      round.revision !== revision ||
      state.chatInputHistoryIndex !== index ||
      state.chatMessage !== draft ||
      next === undefined
    ) {
      return unhandled;
    }
    state.chatInputHistoryIndex = index + 1;
    state.chatMessage = next;
    state.chatMentions = [];
    round.revision += 1;
    return { handled: true, preventDefault: false, restoreCaret: "up" };
  })()
    .catch(() => unhandled)
    .finally(() => {
      if (round.pending === pending) {
        round.pending = undefined;
      }
    });
  round.pending = pending;
  return pending;
}

export function handleChatInputHistoryKey(
  state: ChatInputHistoryState,
  input: ChatInputHistoryKeyInput,
  createReader?: ChatInputHistoryReaderFactory,
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
    (input.selectionStart !== 0 &&
      (input.key === "ArrowUp" || input.selectionEnd !== state.chatMessage.length))
  ) {
    return { handled: false, preventDefault: false, restoreCaret: null };
  }

  if (state.chatInputHistoryIndex === -1 && input.key === "ArrowDown") {
    if (
      state.chatInputHistoryItems &&
      inputHistoryRounds.get(state.chatInputHistoryItems)?.pending
    ) {
      resetChatInputHistoryNavigation(state);
    }
    return { handled: false, preventDefault: false, restoreCaret: null };
  }

  const direction = input.key === "ArrowUp" ? "up" : "down";
  const navigated = navigateChatInputHistory(state, direction, createReader);
  if (!navigated && direction === "up" && state.chatInputHistoryItems) {
    const items = state.chatInputHistoryItems;
    const round = inputHistoryRounds.get(items);
    if (round && !round.exhausted && items.length < CHAT_INPUT_HISTORY_LIMIT) {
      round.read ??= round.createReader?.();
      if (round.pending || round.read) {
        return {
          handled: true,
          preventDefault: true,
          restoreCaret: null,
          completion: round.pending ?? loadOlderChatInputHistory(state, items, round),
        };
      }
    }
  }
  return {
    handled: navigated,
    preventDefault: navigated,
    restoreCaret: navigated ? direction : null,
  };
}
