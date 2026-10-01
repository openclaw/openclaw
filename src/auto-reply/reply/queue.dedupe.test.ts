import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
  clearSessionQueues,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  createQueueSettings,
  createDrainRecorder,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";
import { getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
const settings = createQueueSettings();
let sequence = 0;
let key: string;

function source(prompt: string, overrides: Partial<Parameters<typeof createRun>[0]> = {}) {
  return createRun({
    prompt,
    messageId: "same-id",
    originatingChannel: "line",
    originatingTo: "group:G1",
    ...overrides,
  });
}

beforeEach(() => {
  key = `dedupe-${++sequence}`;
  resetRecentQueuedMessageIdDedupe();
});
afterEach(() => {
  clearSessionQueues([key]);
  vi.useRealTimers();
});

describe("followup queue deduplication", () => {
  it("deduplicates same message_id across distinct enqueue module instances", async () => {
    const enqueueA = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-b",
    );
    const { calls, done, runFollowup } = createDrainRecorder();
    expect(enqueueA.enqueueFollowupRun(key, source("first"), settings)).toBe(true);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(enqueueB.enqueueFollowupRun(key, source("redelivery"), settings)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("rejects a drained redelivery without recreating an empty registry entry", async () => {
    const { calls, done, runFollowup } = createDrainRecorder();
    expect(enqueueFollowupRun(key, source("original"), settings)).toBe(true);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
    expect(calls).toHaveLength(1);
    expect(enqueueFollowupRun(key, source("redelivery"), settings)).toBe(false);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("does not collide recent message-id keys when routing contains delimiters", async () => {
    const { done, runFollowup } = createDrainRecorder();
    expect(
      enqueueFollowupRun(
        key,
        source("first", {
          originatingChannel: "signal|group",
          originatingTo: "peer",
        }),
        settings,
      ),
    ).toBe(true);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(
      enqueueFollowupRun(
        key,
        source("second", {
          originatingChannel: "signal",
          originatingTo: "group|peer",
        }),
        settings,
      ),
    ).toBe(true);
  });

  it.each([
    { storage: "pending", cap: 2, siblings: 1 },
    { storage: "retained-summary", cap: 1, siblings: 1 },
    { storage: "elided-summary", cap: 1, siblings: 2 },
  ])(
    "releases an aborted $storage source while the reply queue stays dormant",
    async ({ storage, cap, siblings }) => {
      const controller = new AbortController();
      const onAbandoned = vi.fn();
      const onSettled = vi.fn();
      const runFollowup = vi.fn(async (_run: FollowupRun) => {});
      const capped: QueueSettings = { ...settings, cap };
      const first = source("retry me");
      first.abortSignal = controller.signal;
      first.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned, onSettled };
      expect(enqueueFollowupRun(key, first, capped, "message-id", runFollowup, false)).toBe(true);
      for (let index = 0; index < siblings; index += 1) {
        expect(
          enqueueFollowupRun(
            key,
            source(`healthy sibling ${index}`, {
              messageId: `healthy-${index}`,
            }),
            capped,
            "message-id",
            runFollowup,
            false,
          ),
        ).toBe(true);
      }
      const queue = getExistingFollowupQueue(key);
      const sources =
        storage === "pending"
          ? queue?.items
          : storage === "retained-summary"
            ? queue?.summarySources
            : queue?.summaryElisions.flatMap((entry) => entry.sources);
      expect(
        sources?.some((run) => run.turnAdoptionLifecycle === first.turnAdoptionLifecycle),
      ).toBe(true);
      expect(onAbandoned).not.toHaveBeenCalled();
      expect(runFollowup).not.toHaveBeenCalled();
      controller.abort(new Error("ingress watchdog released claim"));
      const retry = source("retry me");
      retry.turnAdoptionLifecycle = { onAdopted: () => {} };
      // Retrying ingress must not need a drain or an owner-clear event.
      expect(enqueueFollowupRun(key, retry, settings, "message-id", runFollowup, false)).toBe(true);
      expect(onAbandoned).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(runFollowup.mock.calls.map(([run]) => run.messageId)).toEqual(
        storage === "pending" ? ["same-id"] : [],
      );
      expect(getExistingFollowupQueue(key)?.draining).toBe(false);
    },
  );

  it("releases a compacted source's message identity through its cloned lifecycle", () => {
    const capped: QueueSettings = { ...settings, cap: 1 };
    const onAbandoned = vi.fn();
    const first = source("first");
    first.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned };
    expect(enqueueFollowupRun(key, first, capped)).toBe(true);
    for (const messageId of ["m2", "m3"]) {
      expect(enqueueFollowupRun(key, source(messageId, { messageId }), capped)).toBe(true);
    }
    clearSessionQueues([key]);
    expect(onAbandoned).toHaveBeenCalledOnce();
    const retry = source("first");
    retry.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(enqueueFollowupRun(key, retry, capped)).toBe(true);
  });

  it("does not let a stale abandoned lifecycle release a newer same-id owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    const stalledAdmission = createDeferred();
    const first = source("first");
    first.turnAdoptionLifecycle = {
      onAdopted: () => stalledAdmission.promise,
      onAbandoned: vi.fn(),
    };
    expect(enqueueFollowupRun(key, first, settings)).toBe(true);
    const admission = admitFollowupRunLifecycle(first);
    await vi.advanceTimersByTimeAsync(0);
    clearSessionQueues([key]);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const replacement = source("replacement");
    replacement.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(enqueueFollowupRun(key, replacement, settings)).toBe(true);
    stalledAdmission.reject(new Error("admission failed"));
    await expect(admission).rejects.toThrow("admission failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueueFollowupRun(key, source("duplicate"), settings)).toBe(false);
  });

  it("still deduplicates redelivery of a message whose queued run was admitted", async () => {
    const onAbandoned = vi.fn();
    const run = source("first");
    run.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned };
    expect(enqueueFollowupRun(key, run, settings)).toBe(true);
    await admitFollowupRunLifecycle(run);
    completeFollowupRunLifecycle(run);
    expect(onAbandoned).not.toHaveBeenCalled();
    clearSessionQueues([key]);
    expect(enqueueFollowupRun(key, source("redelivery"), settings)).toBe(false);
  });
});
