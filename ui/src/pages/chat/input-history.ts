import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { setChatError } from "./chat-history-state.ts";
import type { ChatInputHistoryReader } from "./input-history-request.ts";

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
  reader?: ChatInputHistoryReader;
  pending?: { controller: AbortController; completion: Promise<"up" | null> };
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

function cancelPending(round: ChatInputHistoryRound) {
  round.pending?.controller.abort();
  round.pending = undefined;
}

function ownsDraft(state: ChatInputHistoryState, round: ChatInputHistoryRound) {
  return (
    state.sessionKey === round.sessionKey &&
    state.chatMessage === (round.items[round.index] ?? round.draft)
  );
}

export function resetChatInputHistoryNavigation(state: ChatInputHistoryState) {
  if (state.chatInputHistory) {
    cancelPending(state.chatInputHistory);
  }
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
  for (let i = messages.length - 1, users = 0; i >= 0 && users < CHAT_INPUT_HISTORY_LIMIT; i--) {
    const entry = asOptionalRecord(messages[i]);
    const text = userInput(entry);
    if (text) {
      candidates.push({ text, ts: typeof entry?.timestamp === "number" ? entry.timestamp : 0 });
      users++;
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
  createReader?: () => ChatInputHistoryReader | undefined,
): ChatInputHistoryKeyResult {
  let round = state.chatInputHistory;
  if (
    round &&
    ((round.index < 0 && !round.pending && !round.reader?.cursor.selector) ||
      !ownsDraft(state, round))
  ) {
    resetChatInputHistoryNavigation(state);
    round = undefined;
  }
  if (state.chatLoading) {
    return null;
  }
  const up = input.key === "ArrowUp";
  if (!up) {
    // A native caret move also withdraws the pending Up.
    if (round) {
      cancelPending(round);
    }
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
  if (items.length < CHAT_INPUT_HISTORY_LIMIT) {
    if (active.reader && !active.reader.isCurrent()) {
      cancelPending(active);
      active.reader = undefined;
    }
    const reader = (active.reader ??= createReader?.());
    const hasPrefix =
      active.firstMessage !== state.chatMessages[0] &&
      state.chatMessages.includes(active.firstMessage);
    if (reader?.cursor.selector || hasPrefix) {
      if (!active.pending) {
        const controller = new AbortController();
        const current = () =>
          !controller.signal.aborted &&
          !state.chatLoading &&
          state.chatInputHistory === active &&
          active.index === index &&
          ownsDraft(state, active) &&
          reader?.isCurrent() !== false;
        const completion = import("./input-history-older.ts")
          .then(
            ({ recallOlderInput }) =>
              recallOlderInput(state, active, index, controller.signal, current),
            () => {
              if (current()) {
                setChatError(state, (state.recallError = t("lazyView.staleSubtitle")));
              }
              return null;
            },
          )
          .finally(() => {
            if (active.pending?.controller === controller) {
              active.pending = undefined;
            }
          });
        active.pending = { controller, completion };
      }
      return active.pending.completion;
    }
  }
  if (index === -1) {
    resetChatInputHistoryNavigation(state);
  }
  return null;
}
