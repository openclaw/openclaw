import { afterEach, describe, expect, it } from "vitest";
import {
  clearFollowupQueue,
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_DEBOUNCE_MS,
  DEFAULT_QUEUE_DROP,
  FOLLOWUP_QUEUE_STALE_MS,
  FOLLOWUP_QUEUES,
  getExistingFollowupQueue,
  getFollowupQueue,
  MAX_FOLLOWUP_QUEUE_SESSIONS,
  pruneStaleFollowupQueues,
} from "./state.js";
import type { QueueSettings } from "./types.js";

const defaultSettings: QueueSettings = {
  mode: "debounce",
  debounceMs: DEFAULT_QUEUE_DEBOUNCE_MS,
  cap: DEFAULT_QUEUE_CAP,
  dropPolicy: DEFAULT_QUEUE_DROP,
};

afterEach(() => {
  FOLLOWUP_QUEUES.clear();
});

describe("pruneStaleFollowupQueues", () => {
  it("removes idle empty queues older than FOLLOWUP_QUEUE_STALE_MS", () => {
    const now = Date.now();
    const q = getFollowupQueue("session-old", defaultSettings);
    q.lastEnqueuedAt = now - FOLLOWUP_QUEUE_STALE_MS - 1;

    expect(FOLLOWUP_QUEUES.size).toBe(1);
    const pruned = pruneStaleFollowupQueues(now);
    expect(pruned).toBe(1);
    expect(FOLLOWUP_QUEUES.size).toBe(0);
  });

  it("keeps queues that are still within the TTL window", () => {
    const now = Date.now();
    const q = getFollowupQueue("session-recent", defaultSettings);
    q.lastEnqueuedAt = now - 1000;

    const pruned = pruneStaleFollowupQueues(now);
    expect(pruned).toBe(0);
    expect(FOLLOWUP_QUEUES.size).toBe(1);
  });

  it("keeps queues that are draining even if stale", () => {
    const now = Date.now();
    const q = getFollowupQueue("session-draining", defaultSettings);
    q.lastEnqueuedAt = now - FOLLOWUP_QUEUE_STALE_MS - 1;
    q.draining = true;

    const pruned = pruneStaleFollowupQueues(now);
    expect(pruned).toBe(0);
    expect(FOLLOWUP_QUEUES.size).toBe(1);
  });

  it("keeps queues with pending items even if stale", () => {
    const now = Date.now();
    const q = getFollowupQueue("session-pending", defaultSettings);
    q.lastEnqueuedAt = now - FOLLOWUP_QUEUE_STALE_MS - 1;
    q.items.push({ text: "test" } as never);

    const pruned = pruneStaleFollowupQueues(now);
    expect(pruned).toBe(0);
    expect(FOLLOWUP_QUEUES.size).toBe(1);
  });
});

describe("getFollowupQueue auto-pruning", () => {
  it("triggers pruning when map exceeds MAX_FOLLOWUP_QUEUE_SESSIONS", () => {
    const now = Date.now();
    const staleTimestamp = now - FOLLOWUP_QUEUE_STALE_MS - 1;

    // Fill the map with stale entries.
    for (let i = 0; i < MAX_FOLLOWUP_QUEUE_SESSIONS; i++) {
      const q = getFollowupQueue(`stale-${i}`, defaultSettings);
      q.lastEnqueuedAt = staleTimestamp;
    }
    expect(FOLLOWUP_QUEUES.size).toBe(MAX_FOLLOWUP_QUEUE_SESSIONS);

    // Adding one more should trigger pruning.
    getFollowupQueue("new-session", defaultSettings);

    // Stale entries should have been pruned; only the new session remains.
    expect(FOLLOWUP_QUEUES.size).toBe(1);
    expect(FOLLOWUP_QUEUES.has("new-session")).toBe(true);
  });
});

describe("getExistingFollowupQueue", () => {
  it("returns undefined for empty key", () => {
    expect(getExistingFollowupQueue("")).toBeUndefined();
    expect(getExistingFollowupQueue("  ")).toBeUndefined();
  });

  it("returns the queue if it exists", () => {
    getFollowupQueue("test-key", defaultSettings);
    expect(getExistingFollowupQueue("test-key")).toBeDefined();
  });
});

describe("clearFollowupQueue", () => {
  it("returns 0 for non-existent queue", () => {
    expect(clearFollowupQueue("missing")).toBe(0);
  });

  it("clears and removes the queue, returning item count", () => {
    const q = getFollowupQueue("clear-me", defaultSettings);
    q.items.push({ text: "a" } as never, { text: "b" } as never);

    const cleared = clearFollowupQueue("clear-me");
    expect(cleared).toBe(2);
    expect(FOLLOWUP_QUEUES.has("clear-me")).toBe(false);
  });
});
