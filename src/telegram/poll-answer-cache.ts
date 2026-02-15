import { enqueueSystemEvent } from "../infra/system-events.js";

const TTL_MS = 24 * 60 * 60 * 1000;

type PollContext = {
  sessionKey: string;
  question: string;
  options: string[];
  chatId?: string;
  messageId?: string;
  ts: number;
};

const pollContextById = new Map<string, PollContext>();

export type PollAnswerSummary = {
  sessionKey: string;
  question: string;
  selectedOptions: string[];
  selectionText: string;
  chatId?: string;
  messageId?: string;
};

function cleanupExpired() {
  const now = Date.now();
  for (const [pollId, ctx] of pollContextById.entries()) {
    if (now - ctx.ts > TTL_MS) {
      pollContextById.delete(pollId);
    }
  }
}

export function recordSentPollContext(params: {
  pollId: string;
  sessionKey: string;
  question: string;
  options: string[];
  chatId?: string;
  messageId?: string;
}) {
  const pollId = params.pollId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!pollId || !sessionKey) {
    return;
  }
  pollContextById.set(pollId, {
    sessionKey,
    question: params.question,
    options: params.options,
    chatId: params.chatId,
    messageId: params.messageId,
    ts: Date.now(),
  });
  if (pollContextById.size > 500) {
    cleanupExpired();
  }
}

export function enqueuePollAnswerEvent(params: {
  pollId: string;
  userLabel: string;
  optionIds: number[];
}): PollAnswerSummary | null {
  cleanupExpired();
  const pollId = params.pollId.trim();
  const ctx = pollContextById.get(pollId);
  if (!ctx) {
    return null;
  }
  const selected = params.optionIds
    .map((id) => (Number.isInteger(id) && id >= 0 ? ctx.options[id] : undefined))
    .filter((v): v is string => typeof v === "string");
  const selectionText = selected.length > 0 ? selected.join(", ") : "(cleared vote)";
  const text = `Telegram poll answer: ${params.userLabel} selected "${selectionText}" for "${ctx.question}"`;
  enqueueSystemEvent(text, {
    sessionKey: ctx.sessionKey,
    contextKey: `telegram:poll-answer:${pollId}:${params.userLabel}:${selectionText}`,
  });
  return {
    sessionKey: ctx.sessionKey,
    question: ctx.question,
    selectedOptions: selected,
    selectionText,
    chatId: ctx.chatId,
    messageId: ctx.messageId,
  };
}

export function clearPollAnswerCacheForTest() {
  pollContextById.clear();
}
