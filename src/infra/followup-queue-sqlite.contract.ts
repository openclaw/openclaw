/**
 * Typed shared-state worker contract for durable follow-up queue storage.
 *
 * Runtime enqueue and settlement must not run SQLite transactions on the Gateway
 * thread: a full snapshot replacement under database contention blocks unrelated
 * agent and channel work. These commands move the reads and the snapshot
 * replacement into the canonical shared-state worker, leaving the queue owner to
 * decide *what* to store.
 */
export type FollowupQueueEntryRow = {
  queueKey: string;
  data: unknown;
};

type FollowupQueueReplaceInput = {
  entries: Array<[string, unknown]>;
  /** Keys that must survive replacement even when absent from `entries`. */
  retainKeys?: readonly string[];
};

type FollowupQueueContainsPromptInput = {
  queueKey: string;
  prompt: string;
};

export type FollowupQueueWorkerOperations = {
  "followupQueue.listKeys": { input: undefined; output: string[] };
  "followupQueue.listUnreadableKeys": { input: undefined; output: string[] };
  "followupQueue.loadEntry": { input: string; output: { found: boolean; data: unknown } };
  "followupQueue.loadEntries": { input: undefined; output: FollowupQueueEntryRow[] };
  "followupQueue.hasEntries": { input: undefined; output: boolean };
  "followupQueue.replace": { input: FollowupQueueReplaceInput; output: undefined };
  "followupQueue.entryContainsPrompt": {
    input: FollowupQueueContainsPromptInput;
    output: boolean;
  };
};
