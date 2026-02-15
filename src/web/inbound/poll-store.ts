export type StoredPoll = {
  messageId: string;
  chatJid: string;
  question: string;
  options: string[];
  createdAt: number;
  reportedVotes: Set<string>;
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
    store: (poll: Omit<StoredPoll, "reportedVotes">) => {
      polls.set(poll.messageId, { ...poll, reportedVotes: new Set() });
      if (polls.size > 100) {
        cleanup();
      }
    },
    get: (messageId: string): StoredPoll | undefined => {
      cleanup();
      return polls.get(messageId);
    },
    isVoteReported: (messageId: string, voterJid: string): boolean => {
      const poll = polls.get(messageId);
      return poll?.reportedVotes.has(voterJid) ?? false;
    },
    markVoteReported: (messageId: string, voterJid: string): void => {
      const poll = polls.get(messageId);
      if (poll) {
        poll.reportedVotes.add(voterJid);
      }
    },
  };
}

export type PollStore = ReturnType<typeof createPollStore>;
