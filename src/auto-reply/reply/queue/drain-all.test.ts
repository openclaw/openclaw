import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFollowupQueueDrain } from "./drain-all.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";

beforeEach(() => {
  FOLLOWUP_QUEUES.clear();
});

afterEach(() => {
  FOLLOWUP_QUEUES.clear();
  vi.useRealTimers();
});

describe("waitForFollowupQueueDrain", () => {
  it("returns immediately when no followup work is pending", async () => {
    await expect(waitForFollowupQueueDrain(0)).resolves.toEqual({
      drained: true,
      remaining: 0,
    });
  });

  it("counts overflow summaries and an active drain as pending work", async () => {
    vi.useFakeTimers();
    const queue = getFollowupQueue("session", { mode: "followup" });
    queue.droppedCount = 2;
    queue.draining = true;

    const timedOut = waitForFollowupQueueDrain(100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(timedOut).resolves.toEqual({ drained: false, remaining: 3 });
  });

  it("waits until summary and drain state are both clear", async () => {
    vi.useFakeTimers();
    const queue = getFollowupQueue("session", { mode: "followup" });
    queue.droppedCount = 1;
    queue.draining = true;

    const drained = waitForFollowupQueueDrain(1_000);
    queue.droppedCount = 0;
    queue.draining = false;
    await vi.advanceTimersByTimeAsync(50);

    await expect(drained).resolves.toEqual({ drained: true, remaining: 0 });
  });
});
