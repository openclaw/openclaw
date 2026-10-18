import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureSessionControllerSourceSettlement } from "../../sessions/session-controller.mailbox.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
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
import { resetRecentQueuedMessageIdDedupe } from "./queue/recent-message-ids.test-support.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();
const collectSettings: QueueSettings = {
  mode: "collect",
  debounceMs: 0,
  cap: 50,
  dropPolicy: "summarize",
};
const settings = createQueueSettings();
let sequence = 0;
let key: string;

function createFollowupCollector(expectedCalls = 1): {
  calls: FollowupRun[];
  done: ReturnType<typeof createDeferred<void>>;
  runFollowup: (run: FollowupRun) => Promise<void>;
} {
  const calls: FollowupRun[] = [];
  const done = createDeferred();
  return {
    calls,
    done,
    runFollowup: async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    },
  };
}

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
  clearFollowupQueue(key);
  vi.useRealTimers();
});

describe("followup queue deduplication", () => {
  beforeEach(() => {
    resetRecentQueuedMessageIdDedupe();
  });

  it("deduplicates settled redeliveries within their physical store, not across stores", async () => {
    const queueKey = "agent:main:physical-dedupe";
    const makeRun = (store: string) => {
      const run = createRun({
        prompt: store,
        messageId: "same-id",
        originatingChannel: "discord",
        originatingTo: "channel:physical",
      });
      run.run.sessionKey = queueKey;
      run.run.config = { session: { store } };
      return run;
    };
    const originals = [
      makeRun("/synthetic/store-a/sessions.json"),
      makeRun("/synthetic/store-b/sessions.json"),
    ];
    const { calls, done, runFollowup } = createFollowupCollector(2);
    try {
      for (const run of originals) {
        expect(enqueueFollowupRun(queueKey, run, collectSettings, "message-id", runFollowup)).toBe(
          true,
        );
      }
      await done.promise;
      await Promise.all(
        originals.map((run) => {
          if (!run.controllerInput) {
            throw new Error("Expected the canonical source input");
          }
          return captureSessionControllerSourceSettlement(run.controllerInput);
        }),
      );
      for (const run of originals) {
        expect(
          enqueueFollowupRun(
            queueKey,
            makeRun(run.prompt),
            collectSettings,
            "message-id",
            runFollowup,
          ),
        ).toBe(false);
      }
      expect(calls).toHaveLength(2);
    } finally {
      await Promise.all(
        originals.flatMap((run) =>
          run.controllerInput
            ? [captureSessionControllerSourceSettlement(run.controllerInput)]
            : [],
        ),
      );
    }
  });

  it.each(["same run", "shared source view"] as const)(
    "preserves accepted work when a %s is enqueued again after recent dedupe expires",
    async (retryKind) => {
      vi.useFakeTimers();
      const original = source("original queued request");
      const onAbandoned = vi.fn();
      const settled = createDeferred();
      const onSettled = vi.fn(() => settled.resolve());
      const onAdopted = vi.fn();
      original.turnAdoptionLifecycle = { onAdopted, onAbandoned, onSettled };
      const runFollowup = vi.fn(async (run: FollowupRun) => {
        expect(run).toBe(original);
        await admitFollowupRunLifecycle(run);
      });
      expect(enqueueFollowupRun(key, original, settings, "message-id", runFollowup, false)).toBe(
        true,
      );
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      const retry = retryKind === "same run" ? original : { ...original };
      expect(enqueueFollowupRun(key, retry, settings, "message-id", runFollowup, false)).toBe(
        false,
      );
      expect(onAbandoned).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
      expect(getExistingFollowupQueue(key)?.items).toEqual([original]);
      vi.useRealTimers();
      scheduleFollowupDrain(key, runFollowup);
      await settled.promise;
      expect(runFollowup).toHaveBeenCalledExactlyOnceWith(original);
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(onAbandoned).not.toHaveBeenCalled();
    },
  );

  it("deduplicates messages with same Discord message_id", async () => {
    const queueKey = `test-dedup-message-id-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    const first = enqueueFollowupRun(
      queueKey,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      queueKey,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello (dupe)",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(second).toBe(false);

    const third = enqueueFollowupRun(
      queueKey,
      createRun({
        prompt: "[Discord Guild #test channel id:123] World",
        messageId: "m2",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(queueKey, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
  });

  it("deduplicates message ids when numeric and string thread ids share a route", () => {
    const queueKey = `test-dedup-thread-normalized-${Date.now()}`;

    const first = enqueueFollowupRun(
      queueKey,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: 42.9,
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      queueKey,
      createRun({
        prompt: "second",
        messageId: "same-id",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: "42",
      }),
      collectSettings,
    );
    expect(second).toBe(false);
  });

  it("deduplicates redelivery after reply policy changes", async () => {
    const queueKey = `test-dedup-policy-change-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    expect(
      enqueueFollowupRun(
        queueKey,
        createRun({
          prompt: "first",
          messageId: "same-id",
          originatingChannel: "slack",
          originatingTo: "U123",
          originatingReplyToId: "101.001",
          originatingReplyToMode: "off",
          originatingChatType: "direct",
        }),
        collectSettings,
      ),
    ).toBe(true);

    scheduleFollowupDrain(queueKey, runFollowup);
    await done.promise;

    expect(
      enqueueFollowupRun(
        queueKey,
        createRun({
          prompt: "redelivery",
          messageId: "same-id",
          originatingChannel: "slack",
          originatingTo: "U123",
          originatingReplyToId: "101.001",
          originatingReplyToMode: "first",
          originatingChatType: "direct",
        }),
        collectSettings,
      ),
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

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
    expect(getExistingFollowupQueue(key)).toBeUndefined();
    expect(enqueueB.enqueueFollowupRun(key, source("redelivery"), settings)).toBe(false);
    expect(calls).toHaveLength(1);
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
      const runFollowup = vi.fn(async (run: FollowupRun) => {
        expect(run.abortSignal?.aborted).toBe(true);
      });
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
      await first.controllerInput!.settlement.promise;
      expect(onSettled).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(runFollowup).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ messageId: "same-id", abortSignal: controller.signal }),
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
    clearFollowupQueue(key);
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
    clearFollowupQueue(key);
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
    clearFollowupQueue(key);
    expect(enqueueFollowupRun(key, source("redelivery"), settings)).toBe(false);
  });
});
