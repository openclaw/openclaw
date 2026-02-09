import { describe, it, expect, beforeEach } from "vitest";
import {
  FOLLOWUP_QUEUES,
  getFollowupQueue,
  clearFollowupQueue,
  pruneStaleFollowupQueues,
} from "./state.js";

beforeEach(() => {
  FOLLOWUP_QUEUES.clear();
});

describe("pruneStaleFollowupQueues", () => {
  it("removes empty idle queues older than maxAge", () => {
    const q = getFollowupQueue("sess-1", { mode: "fifo" });
    q.lastEnqueuedAt = Date.now() - 20 * 60_000; // 20 min ago
    expect(FOLLOWUP_QUEUES.size).toBe(1);

    const pruned = pruneStaleFollowupQueues(10 * 60_000);
    expect(pruned).toBe(1);
    expect(FOLLOWUP_QUEUES.size).toBe(0);
  });

  it("keeps queues that are still draining", () => {
    const q = getFollowupQueue("sess-2", { mode: "fifo" });
    q.lastEnqueuedAt = Date.now() - 20 * 60_000;
    q.draining = true;

    const pruned = pruneStaleFollowupQueues(10 * 60_000);
    expect(pruned).toBe(0);
    expect(FOLLOWUP_QUEUES.size).toBe(1);
  });

  it("keeps queues with pending items", () => {
    const q = getFollowupQueue("sess-3", { mode: "fifo" });
    q.lastEnqueuedAt = Date.now() - 20 * 60_000;
    q.items.push({ prompt: "test", run: {} as any, enqueuedAt: Date.now() });

    const pruned = pruneStaleFollowupQueues(10 * 60_000);
    expect(pruned).toBe(0);
  });

  it("keeps recently active queues", () => {
    const q = getFollowupQueue("sess-4", { mode: "fifo" });
    q.lastEnqueuedAt = Date.now() - 1000; // 1 sec ago

    const pruned = pruneStaleFollowupQueues(10 * 60_000);
    expect(pruned).toBe(0);
    expect(FOLLOWUP_QUEUES.size).toBe(1);
  });
});
