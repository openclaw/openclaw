import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { extractText } from "../../lib/chat/message-extract.ts";

export const CHAT_INPUT_HISTORY_LIMIT = 100;

type ChatLocalInputHistoryEntry = {
  text: string;
  ts: number;
};

export type ChatInputHistoryState = {
  sessionKey: string;
  chatLoading: boolean;
  chatError?: string | null;
  lastError?: string | null;
  recallError?: string;
  chatMessage: string;
  chatMentions?: readonly HumanMention[];
  chatMessages: unknown[];
  chatLocalInputHistoryBySession: Record<string, ChatLocalInputHistoryEntry[]>;
  chatInputHistory?: ChatInputHistoryRound;
};

export type ChatInputHistoryKeyInput = {
  key: "ArrowUp" | "ArrowDown";
  selectionStart: number;
  selectionEnd: number;
  modified?: boolean;
};

// A deferred Up consumes the key synchronously; null leaves it to the browser.
export type ChatInputHistoryKeyResult = "up" | "down" | null | Promise<"up" | null>;

export type ChatInputHistoryRound = {
  sessionKey: string;
  items: string[];
  index: number;
  firstMessage: unknown;
  draft: string;
  mentions?: readonly HumanMention[];
  // The paging owner retains its cursor and request; local navigation can only
  // continue it or withdraw the pending Up.
  older?: {
    current(): boolean;
    hasMore(): boolean;
    cancel(): void;
    next(): Promise<"up" | null> | null;
  };
};

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

function ownsDraft(state: ChatInputHistoryState, round: ChatInputHistoryRound) {
  return (
    state.sessionKey === round.sessionKey &&
    state.chatMessage === (round.items[round.index] ?? round.draft)
  );
}

export function resetChatInputHistoryNavigation(state: ChatInputHistoryState) {
  state.chatInputHistory?.older?.cancel();
  state.chatInputHistory = undefined;
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

// Older rows must not displace a draft or shift the order of an active traversal.
function beginRound(state: ChatInputHistoryState): ChatInputHistoryRound {
  const messages = state.chatMessages;
  const candidates = [...(state.chatLocalInputHistoryBySession[state.sessionKey] ?? [])];
  const users = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && users.size < CHAT_INPUT_HISTORY_LIMIT; i--) {
    const entry = asOptionalRecord(messages[i]);
    const text = userInput(entry);
    if (text && !users.has(text)) {
      users.add(text);
      candidates.push({ text, ts: typeof entry?.timestamp === "number" ? entry.timestamp : 0 });
    }
  }
  candidates.sort((a, b) => b.ts - a.ts);
  return {
    sessionKey: state.sessionKey,
    items: [...new Set(candidates.map(({ text }) => text))].slice(0, CHAT_INPUT_HISTORY_LIMIT),
    index: -1,
    firstMessage: messages[0],
    draft: state.chatMessage,
    mentions: state.chatMentions,
  };
}

export function userInput(entry: ReturnType<typeof asOptionalRecord>) {
  const text =
    typeof entry?.role === "string" && entry.role.toLowerCase() === "user"
      ? extractText(entry)
      : undefined;
  return text?.trim() ? text : undefined;
}

export function handleChatInputHistoryKey(
  state: ChatInputHistoryState,
  input: ChatInputHistoryKeyInput,
  extend?: (round: ChatInputHistoryRound) => Promise<"up" | null> | null,
): ChatInputHistoryKeyResult {
  let round = state.chatInputHistory;
  if (round && ((round.index < 0 && !round.older?.hasMore()) || !ownsDraft(state, round))) {
    resetChatInputHistoryNavigation(state);
    round = undefined;
  }
  if (state.chatLoading) {
    return null;
  }
  const up = input.key === "ArrowUp";
  if (!up) {
    // A native caret move also withdraws the pending Up.
    round?.older?.cancel();
    if (!round || round.index === -1) {
      resetChatInputHistoryNavigation(state);
      return null;
    }
  }
  if (
    input.modified ||
    input.selectionStart !== input.selectionEnd ||
    (input.selectionStart !== 0 && (up || input.selectionEnd !== state.chatMessage.length))
  ) {
    return null;
  }
  const active = (state.chatInputHistory ??= beginRound(state));
  const { items, index } = active;
  const nextIndex = index + (up ? 1 : -1);
  if (nextIndex < items.length) {
    active.index = nextIndex;
    state.chatMessage = items[nextIndex] ?? active.draft;
    state.chatMentions = nextIndex === -1 ? active.mentions : [];
    if (nextIndex === -1) {
      resetChatInputHistoryNavigation(state);
    }
    return up ? "up" : "down";
  }
  if (items.length < CHAT_INPUT_HISTORY_LIMIT && extend) {
    const pending = extend(active);
    if (pending) {
      return pending;
    }
  }
  if (index === -1) {
    resetChatInputHistoryNavigation(state);
  }
  return null;
}
