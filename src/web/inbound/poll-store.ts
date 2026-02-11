export type StoredPoll = {
  messageId: string;
  chatJid: string;
  question: string;
  options: string[];
  createdAt: number;
};

const POLL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createPollStore() {
  const polls = new Map<string, StoredPoll>();

  const cleanup = () => {
    const now = Date.now();
    for (const [key, poll] of polls) {
      if (now - poll.createdAt > POLL_TTL_MS) {
        polls.delete(key);
      }
    }
  };

  return {
    store: (poll: StoredPoll) => {
      polls.set(poll.messageId, poll);
      if (polls.size > 100) {
        cleanup();
      }
    },
    get: (messageId: string): StoredPoll | undefined => {
      cleanup();
      return polls.get(messageId);
    },
  };
}

export type PollStore = ReturnType<typeof createPollStore>;
