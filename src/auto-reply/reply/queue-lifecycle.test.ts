import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueuedFollowupLifecycleForQueue,
  consumeQueuedFollowupStartNotice,
  registerQueuedFollowupLifecycle,
  resetQueuedFollowupLifecycleForTests,
} from "./queue-lifecycle.js";
import { createMockFollowupRun } from "./test-helpers.js";

describe("queue lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));
    resetQueuedFollowupLifecycleForTests();
  });

  afterEach(() => {
    resetQueuedFollowupLifecycleForTests();
    vi.useRealTimers();
  });

  it("emits queued and delayed notices at their thresholds", async () => {
    const notices: string[] = [];
    const run = createMockFollowupRun();

    registerQueuedFollowupLifecycle({
      queueKey: "main",
      run,
      sendNotice: (payload) => {
        if (payload.text) {
          notices.push(payload.text);
        }
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(notices).toEqual([
      "Queued behind earlier work. I have your message and will reply when the lane clears.",
    ]);

    await vi.advanceTimersByTimeAsync(28_000);
    expect(notices).toEqual([
      "Queued behind earlier work. I have your message and will reply when the lane clears.",
      "Still queued behind earlier work. I still have your message and will reply when the lane clears.",
    ]);
  });

  it("emits a resumed notice when a queued turn starts after backlog clears", async () => {
    const run = createMockFollowupRun();

    registerQueuedFollowupLifecycle({
      queueKey: "main",
      run,
    });

    await vi.advanceTimersByTimeAsync(2_100);

    expect(
      consumeQueuedFollowupStartNotice({
        queueKey: "main",
        run,
      }),
    ).toEqual({
      text: "Resumed after backlog cleared after 2s. Thanks for waiting.",
    });
  });

  it("emits a catching-up notice when backlog remains behind the resumed turn", async () => {
    const run = createMockFollowupRun();

    registerQueuedFollowupLifecycle({
      queueKey: "main",
      run,
    });

    await vi.advanceTimersByTimeAsync(2_100);

    expect(
      consumeQueuedFollowupStartNotice({
        queueKey: "main",
        run,
        remainingQueuedCount: 1,
      }),
    ).toEqual({
      text: "Catching up after backlog cleared after 2s. Thanks for waiting.",
    });
  });

  it("consumes multiple queued refs when a synthesized batch starts", async () => {
    const first = createMockFollowupRun({
      messageId: "first-msg",
    });
    const second = createMockFollowupRun({
      messageId: "second-msg",
      enqueuedAt: first.enqueuedAt + 100,
    });

    registerQueuedFollowupLifecycle({
      queueKey: "main",
      run: first,
    });
    registerQueuedFollowupLifecycle({
      queueKey: "main",
      run: second,
    });

    await vi.advanceTimersByTimeAsync(2_100);

    expect(
      consumeQueuedFollowupStartNotice({
        queueKey: "main",
        refs: [first, second],
      }),
    ).toEqual({
      text: "Resumed after backlog cleared after 2s. Thanks for waiting.",
    });
    expect(
      consumeQueuedFollowupStartNotice({
        queueKey: "main",
        refs: [first, second],
      }),
    ).toBeUndefined();
  });

  it("clears queued lifecycle state for a queue without leaking notices", async () => {
    const notices: string[] = [];
    const run = createMockFollowupRun();

    registerQueuedFollowupLifecycle({
      queueKey: "main",
      run,
      sendNotice: (payload) => {
        if (payload.text) {
          notices.push(payload.text);
        }
      },
    });

    clearQueuedFollowupLifecycleForQueue("main");
    await vi.advanceTimersByTimeAsync(31_000);

    expect(notices).toEqual([]);
    expect(
      consumeQueuedFollowupStartNotice({
        queueKey: "main",
        run,
      }),
    ).toBeUndefined();
  });
});
