import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFollowupQueueDrain } from "./drain-all.js";
import { FOLLOWUP_QUEUES, type FollowupQueueState } from "./state.js";

function createMockQueue(overrides: Partial<FollowupQueueState> = {}): FollowupQueueState {
  return {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: "followup",
    debounceMs: 1000,
    cap: 20,
    dropPolicy: "summarize",
    droppedCount: 0,
    summaryLines: [],
    ...overrides,
  };
}

afterEach(() => {
  FOLLOWUP_QUEUES.clear();
});

describe("waitForFollowupQueueDrain", () => {
  it("returns drained immediately when no queues exist", async () => {
    const result = await waitForFollowupQueueDrain(1000);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });

  it("returns drained immediately when all queues are empty", async () => {
    FOLLOWUP_QUEUES.set("test", createMockQueue());
    const result = await waitForFollowupQueueDrain(1000);
    expect(result).toEqual({ drained: true, remaining: 0 });
  });

  it("waits until queues are drained", async () => {
    const queue = createMockQueue({
      items: [
        { prompt: "test", run: vi.fn() as unknown, enqueuedAt: Date.now() },
      ] as FollowupQueueState["items"],
      draining: true,
    });
    FOLLOWUP_QUEUES.set("test", queue);

    // Simulate drain completing after 100ms
    setTimeout(() => {
      queue.items.length = 0;
      queue.draining = false;
      FOLLOWUP_QUEUES.delete("test");
    }, 100);

    const result = await waitForFollowupQueueDrain(5000);
    expect(result.drained).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("returns not drained on timeout", async () => {
    const queue = createMockQueue({
      items: [
        { prompt: "test", run: vi.fn() as unknown, enqueuedAt: Date.now() },
      ] as FollowupQueueState["items"],
      draining: true,
    });
    FOLLOWUP_QUEUES.set("test", queue);

    const result = await waitForFollowupQueueDrain(100);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it("counts draining queues as having pending items even with empty items array", async () => {
    const queue = createMockQueue({ draining: true });
    FOLLOWUP_QUEUES.set("test", queue);

    // Queue has no items but is still draining — should wait
    const result = await waitForFollowupQueueDrain(100);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBeGreaterThanOrEqual(1);
  });

  it("reports each draining queue in the timeout remaining count", async () => {
    FOLLOWUP_QUEUES.set("queue-1", createMockQueue({ draining: true }));
    FOLLOWUP_QUEUES.set("queue-2", createMockQueue({ draining: true }));
    FOLLOWUP_QUEUES.set("queue-3", createMockQueue({ draining: true }));

    const result = await waitForFollowupQueueDrain(1);
    expect(result).toEqual({ drained: false, remaining: 3 });
  });
});
