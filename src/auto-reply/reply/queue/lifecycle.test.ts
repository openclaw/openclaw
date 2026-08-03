import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { FollowupRun, QueueSettings } from "../queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "../queue.js";
import { createQueueTestRun as createRun } from "../queue.test-helpers.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  markFollowupRunEnqueued,
} from "./lifecycle.js";

afterEach(() => vi.useRealTimers());

describe("followup lifecycle heartbeat", () => {
  it.each(["admitted", "completed", "aborted"] as const)(
    "does not start renewal for an already %s lifecycle",
    async (state) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const lifecycle = {
        admission: "exclusive" as const,
        abortSignal: abort.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onDeferredHeartbeat: vi.fn(),
        deferredHeartbeatIntervalMs: 100,
        onAbandoned: vi.fn(),
      };
      const run = { turnAdoptionLifecycle: lifecycle };
      if (state === "admitted") {
        await admitFollowupRunLifecycle(run);
      } else if (state === "completed") {
        completeFollowupRunLifecycle(run);
      } else {
        abort.abort();
      }
      try {
        markFollowupRunEnqueued(run);
        await vi.advanceTimersByTimeAsync(500);
        expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        completeFollowupRunLifecycle(run);
      }
    },
  );
});

function createQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return {
    mode: "collect",
    debounceMs: 0,
    cap: 50,
    dropPolicy: "summarize",
    ...overrides,
  };
}

describe("followup queue collect cancellation retirement on freeze", () => {
  it("retires all source cancellations when admitted overflow delivery freezes", async () => {
    const key = `test-overflow-summary-freeze-retire-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred();
    const sourceCancellationRetirements = [vi.fn(), vi.fn()];
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    for (const [index, prompt] of ["first dropped", "second dropped"].entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          abortSignal: new AbortController().signal,
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onCancellationRetired: sourceCancellationRetirements[index],
            onSettled: () => {},
          },
        },
        settings,
      );
    }
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
        await run.turnAdoptionLifecycle?.onAdopted?.();
        run.turnAdoptionLifecycle?.onCancellationRetired?.();
        expect(sourceCancellationRetirements[0]).toHaveBeenCalledTimes(1);
        expect(sourceCancellationRetirements[1]).toHaveBeenCalledTimes(1);
        run.turnAdoptionLifecycle?.onSettled?.();
        return;
      }
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe("live followup");
  });

  it("retires a singleton cancel-only overflow source when the summary freezes", async () => {
    const key = `test-overflow-summary-singleton-freeze-retire-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred();
    const sourceCancellationRetirement = vi.fn();
    const sourceComplete = vi.fn();
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(key, createRun({ prompt: "dropped plain" }), settings);
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped cancel-only" }),
        abortSignal: new AbortController().signal,
        turnAdoptionLifecycle: {
          admission: "cancel-only",
          onAdopted: async () => {},
          onCancellationRetired: sourceCancellationRetirement,
          onSettled: sourceComplete,
        },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
        expect(run.turnAdoptionLifecycle).toBeDefined();
        await run.turnAdoptionLifecycle?.onAdopted?.();
        run.turnAdoptionLifecycle?.onCancellationRetired?.();
        expect(sourceCancellationRetirement).toHaveBeenCalledTimes(1);
        run.turnAdoptionLifecycle?.onSettled?.();
        return;
      }
      done.resolve();
    });
    await done.promise;

    expect(sourceComplete).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe("live followup");
  });

  it("retires all source cancellations when an admitted collect group freezes", async () => {
    const key = `test-collect-freeze-retire-${Date.now()}`;
    const done = createDeferred();
    const sourceCancellationRetirements = [vi.fn(), vi.fn()];
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    for (const [index, prompt] of ["first", "second"].entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          abortSignal: new AbortController().signal,
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onCancellationRetired: sourceCancellationRetirements[index],
            onSettled: () => {},
          },
        },
        settings,
      );
    }

    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("first") || run.prompt.includes("second")) {
        await run.turnAdoptionLifecycle?.onAdopted?.();
        run.turnAdoptionLifecycle?.onCancellationRetired?.();
        expect(sourceCancellationRetirements[0]).toHaveBeenCalledTimes(1);
        expect(sourceCancellationRetirements[1]).toHaveBeenCalledTimes(1);
        run.turnAdoptionLifecycle?.onSettled?.();
      }
      done.resolve();
    });
    await done.promise;
  });
});
