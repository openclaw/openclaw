const TTL_MS = 24 * 60 * 60 * 1000;

export type TelegramSentPoll = {
  pollId: string;
  chatId: string;
  question: string;
  options: string[];
  accountId?: string;
  createdAt: number;
};

const pollById = new Map<string, TelegramSentPoll>();

function cleanupExpired() {
  const now = Date.now();
  for (const [pollId, poll] of pollById) {
    if (now - poll.createdAt > TTL_MS) {
      pollById.delete(pollId);
    }
  }
}

export function recordSentPoll(poll: Omit<TelegramSentPoll, "createdAt">) {
  cleanupExpired();
  pollById.set(poll.pollId, { ...poll, createdAt: Date.now() });
}

export function getSentPoll(pollId: string): TelegramSentPoll | undefined {
  cleanupExpired();
  return pollById.get(pollId);
}

export function clearSentPollCache() {
  pollById.clear();
}
