import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createChannelIngressError } from "./ingress-errors.js";
import {
  CHANNEL_INGRESS_RETENTION_DEFAULTS,
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import {
  createMonitor,
  PermanentIngressError,
  useIngressMonitorQueueFixture,
  waitForAbort,
  type RawEvent,
  type StoredEvent,
} from "./ingress-monitor.test-harness.js";
import type { ChannelIngressQueue } from "./ingress-queue.js";
import {
  ChannelIngressUnavailableError,
  isChannelIngressUnavailableError,
} from "./ingress-unavailable.js";

const withQueue = useIngressMonitorQueueFixture();
const queueIt = (name: string, run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<void>) =>
  it(name, () => withQueue(run));
const event = (id: string, lane = "a", text = "hello"): RawEvent => ({ id, lane, text });
const stored = (raw: RawEvent): StoredEvent => ({ version: 1, rawEvent: JSON.stringify(raw) });
const stopWhenIdle = async (monitor: ReturnType<typeof createMonitor>) => {
  await monitor.waitForIdle();
  await monitor.stop();
};
const startWith = async (monitor: ReturnType<typeof createMonitor>, raw: RawEvent) => {
  monitor.start();
  await monitor.admit(raw);
};
function gateNextScan(queue: ChannelIngressQueue<StoredEvent>) {
  const started = createDeferred();
  const gate = createDeferred();
  const listUnsettled = queue.listUnsettled!.bind(queue);
  let first = true;
  queue.listUnsettled = async (...args) => {
    if (first) {
      first = false;
      started.resolve();
      await gate.promise;
    }
    return await listUnsettled(...args);
  };
  return { started: started.promise, release: gate.resolve };
}

describe("channel ingress monitor", () => {
  it("creates named plain and reasoned ingress errors", () => {
    const PayloadError = createChannelIngressError("TestIngressPayloadError");
    const PermanentError = createChannelIngressError<"invalid-event">("TestIngressPermanentError", {
      withReason: true,
    });
    expect(PayloadError.name).toBe("TestIngressPayloadError");
    const payloadError = new PayloadError("invalid");
    expect(payloadError).toMatchObject({
      name: "TestIngressPayloadError",
      message: "invalid",
    });
    expect(payloadError).toBeInstanceOf(PayloadError);
    expect("reason" in payloadError).toBe(false);
    expect(new PermanentError("invalid-event", "invalid")).toMatchObject({
      name: "TestIngressPermanentError",
      reason: "invalid-event",
      message: "invalid",
    });
  });

  it.each([
    ["standard", 20_000],
    [{ completedMaxEntries: 1_000 }, 1_000],
  ] as const)(
    "prunes standard retention with %s overrides",
    async (retention, completedMaxEntries) => {
      await withQueue(async (queue) => {
        let currentTime = CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs;
        const prune = vi.spyOn(queue, "prune");
        const monitor = createMonitor(queue, vi.fn(), {
          retention,
          now: () => currentTime,
        });
        monitor.start();
        await monitor.waitForIdle();
        expect(prune).toHaveBeenCalledOnce();
        expect(prune).toHaveBeenCalledWith({
          completedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.completedTtlMs,
          completedMaxEntries,
          failedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedTtlMs,
          failedMaxEntries: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedMaxEntries,
          now: expect.any(Number),
        });
        currentTime += CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs;
        monitor.requestDrain();
        await monitor.waitForPumpIdle();
        expect(prune).toHaveBeenCalledTimes(2);
        await monitor.stop();
      });
    },
  );

  queueIt("never prunes zero-interval retention on startup or idle polls", async (queue) => {
    const prune = vi.spyOn(queue, "prune");
    const monitor = createMonitor(queue, vi.fn(), {
      retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
    });
    vi.useFakeTimers();
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(65);
      await monitor.stop();
      expect(prune).not.toHaveBeenCalled();
    } finally {
      try {
        await monitor.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it.each([false, true])(
    "prunes once before %s batch admission, ignoring filtered events",
    async (batch) => {
      await withQueue(async (queue) => {
        const prune = vi.spyOn(queue, "prune");
        const enqueue = vi.spyOn(queue, "enqueue");
        const enqueueBatch = vi.spyOn(queue, "enqueueBatch");
        const monitor = createMonitor(queue, vi.fn(), {
          inspect: (raw) =>
            raw.id === "ignored" ? null : { eventId: raw.id, laneKey: `lane:${raw.lane}` },
          retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
        });
        if (batch) {
          await monitor.admitBatch([
            event("ignored", "a", "receipt"),
            event("event-batch-1", "a", "first"),
            event("event-batch-2", "b", "second"),
            event("event-batch-3", "c", "third"),
          ]);
          expect((await queue.listPending()).map((row) => row.id)).toEqual([
            "event-batch-1",
            "event-batch-2",
            "event-batch-3",
          ]);
        } else {
          await expect(monitor.admit(event("ignored", "a", "receipt"))).resolves.toEqual({
            kind: "ignored",
          });
          expect(prune).not.toHaveBeenCalled();
          expect(enqueue).not.toHaveBeenCalled();
          await monitor.admit(event("event-one"));
        }
        const append = batch ? enqueueBatch : enqueue;
        expect(prune).toHaveBeenCalledOnce();
        expect(append).toHaveBeenCalledOnce();
        expect(Math.max(...prune.mock.invocationCallOrder)).toBeLessThan(
          Math.min(...append.mock.invocationCallOrder),
        );
        await monitor.stop();
      });
    },
  );

  queueIt("recovers committed batches after lost acknowledgments", async (queue) => {
    const monitor = createMonitor(queue, vi.fn(), {
      onDurableAdmission: () => {
        throw new Error("lost acknowledgment");
      },
    });
    await expect(
      monitor.admitBatch([event("first", "a", "one"), event("second", "a", "two")]),
    ).rejects.toThrow("lost acknowledgment");
    await monitor.stop();
    const delivered: string[] = [];
    const restarted = createMonitor(queue, (raw) => {
      delivered.push(raw.id);
    });
    restarted.start();
    await stopWhenIdle(restarted);
    expect(delivered).toEqual(["first", "second"]);
    expect(await queue.listPending()).toEqual([]);
  });

  queueIt("dead-letters changed decoded lane identities", async (queue) => {
    await queue.enqueue("event-original", stored(event("event-original", "changed")), {
      laneKey: "lane:original",
    });
    const deliver = vi.fn();
    const monitor = createMonitor(queue, deliver);
    monitor.start();
    await monitor.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
    await expect(
      queue.enqueue("event-original", { version: 1, rawEvent: "duplicate" }),
    ).resolves.toMatchObject({ kind: "failed", record: { reason: "invalid-event" } });
    await monitor.stop();
  });
  it.each([
    { kind: "legacy", storedLaneKey: undefined, schedulingLaneKey: "lane:a" },
    { kind: "per-event", storedLaneKey: "lane:a", schedulingLaneKey: "lane:a:event-derived" },
  ])(
    "preserves transport identity with a $kind scheduling lane",
    async ({ storedLaneKey, schedulingLaneKey }) => {
      await withQueue(async (queue) => {
        await queue.enqueue("event-derived", stored(event("event-derived")), {
          laneKey: storedLaneKey,
        });
        const deliver = vi.fn();
        const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
          queue,
          inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
          payload: {
            storage: "raw-event",
            version: 1,
            serialize: (raw) => JSON.stringify(raw),
            deserialize: (body) => JSON.parse(body) as RawEvent,
            createClaimError: (kind) => new PermanentIngressError(kind),
          },
          deliver,
          pollIntervalMs: 10,
          retention: { pruneIntervalMs: 60_000 },
          drain: {
            deriveLaneKey: () => schedulingLaneKey,
            resolveNonRetryableFailure: (error) =>
              error instanceof PermanentIngressError
                ? { reason: "invalid-event", message: error.message }
                : null,
          },
        });
        monitor.start();
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
        await monitor.stop();
      });
    },
  );

  queueIt("drains the next lane event after adoption, before delivery ends", async (queue) => {
    const { promise: firstDone, resolve: releaseFirst } = createDeferred();
    const delivered: string[] = [];
    const monitor = createMonitor(queue, async (raw, lifecycle) => {
      delivered.push(raw.id);
      await lifecycle.onAdopted();
      if (raw.id === "event-first") {
        await firstDone;
      }
    });
    await startWith(monitor, event("event-first", "a", "slow"));
    await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));
    await monitor.admit(event("event-second", "a", "fast"));
    await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));
    releaseFirst?.();
    await stopWhenIdle(monitor);
  });

  queueIt("re-arms coalesced idle wakes for later retries", async (queue) => {
    const { promise: firstGate, resolve: releaseFirst } = createDeferred();
    const { promise: retryGate, resolve: releaseRetry } = createDeferred();
    const delivered: string[] = [];
    let retryAttempts = 0;
    const monitor = createMonitor(
      queue,
      async (raw) => {
        delivered.push(raw.id);
        if (raw.id === "event-first") {
          await firstGate;
        } else if (retryAttempts++ === 0) {
          await retryGate;
          return { kind: "failed-retryable", error: new Error("retry") };
        }
        return { kind: "completed" };
      },
      { pollIntervalMs: 60_000, retryPolicy: { baseMs: 0, maxMs: 0 } },
    );
    await startWith(monitor, event("event-first", "first", "slow"));
    await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));
    await monitor.admit(event("event-retry", "retry", "retry"));
    await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-retry"]));
    releaseFirst();
    await vi.waitFor(async () =>
      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["event-retry"]),
    );
    releaseRetry();
    await vi.waitFor(() =>
      expect(delivered).toEqual(["event-first", "event-retry", "event-retry"]),
    );
    await stopWhenIdle(monitor);
  });

  // Deferred transport work releases the lane; cancellation can reopen an older head.
  queueIt("dispatches reopened heads before backed-off newer siblings", async (queue) => {
    const delivered: string[] = [];
    let cancelHead: (() => Promise<void>) | undefined;
    const monitor = createMonitor(
      queue,
      async (raw, lifecycle) => {
        delivered.push(raw.id);
        if (raw.id !== "event-head") {
          return { kind: "failed-retryable", error: new Error("tail delivery failed") };
        }
        if (cancelHead) {
          return { kind: "completed" };
        }
        cancelHead = async () => await lifecycle.onCancelled?.();
        return { kind: "deferred" };
      },
      {
        deferredLaneOccupancy: "release",
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
      },
    );
    await startWith(monitor, event("event-head", "a", "head"));
    await vi.waitFor(() => expect(delivered).toEqual(["event-head"]));
    await monitor.admit(event("event-tail", "a", "tail"));
    await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail"]));
    await vi.waitFor(async () =>
      expect(
        (await queue.listPending({ limit: "all", orderBy: "received" })).map((row) => row.id),
      ).toEqual(["event-tail"]),
    );
    expect(cancelHead).toBeDefined();
    await cancelHead?.();
    await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail", "event-head"]));
    await monitor.waitForIdle();
    expect(delivered).toEqual(["event-head", "event-tail", "event-head"]);
    await monitor.stop();
  });

  queueIt("defers restart-drained claims without spending retries", async (queue) => {
    const raw = event("event-restart-drain", "a", "recover me");
    const drainErrors: unknown[] = [];
    const adopt = (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) =>
      runWithGatewayIndependentRootWorkAdmission(() => lifecycle.onAdopted());
    const oldDeliver = vi.fn(async (input: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      try {
        await adopt(input, lifecycle);
      } catch (error) {
        drainErrors.push(error);
        throw error;
      }
    });
    const monitorOptions = {
      pollIntervalMs: 60_000,
      retryPolicy: {
        maxAttempts: 8,
        deadLetterMinAgeMs: 0,
        baseMs: 0,
        maxMs: 0,
      },
    } as const;
    const oldMonitor = createMonitor(queue, oldDeliver, monitorOptions);
    let successorMonitor: ReturnType<typeof createMonitor> | undefined;
    oldMonitor.start();
    try {
      await oldMonitor.waitForIdle();
      const { started: pendingScanStarted, release: releasePendingScan } = gateNextScan(queue);
      oldMonitor.requestDrain();
      await pendingScanStarted;
      markGatewayRestartDraining();
      await queue.enqueue(raw.id, stored(raw), { laneKey: "lane:a" });
      releasePendingScan();
      await vi.waitFor(() => expect(drainErrors.length).toBeGreaterThan(0));
      for (let cycle = 0; cycle < 8; cycle += 1) {
        oldMonitor.requestDrain();
        await oldMonitor.waitForIdle();
      }
      expect(drainErrors[0]).toBeInstanceOf(GatewayDrainingError);
      expect(drainErrors).toHaveLength(1);
      expect(oldDeliver).toHaveBeenCalledOnce();
      await expect(queue.listClaims()).resolves.toEqual([]);
      await expect(queue.listPending()).resolves.toEqual([
        expect.objectContaining({ id: raw.id, attempts: 0 }),
      ]);
      await expect(queue.listFailed?.()).resolves.toEqual([]);
      await oldMonitor.stop();
      resetGatewayWorkAdmission();
      const successorDeliver = vi.fn(adopt);
      successorMonitor = createMonitor(queue, successorDeliver, monitorOptions);
      successorMonitor.start();
      await successorMonitor.waitForIdle();
      expect(successorDeliver).toHaveBeenCalledOnce();
      expect(oldDeliver).toHaveBeenCalledOnce();
      await expect(
        queue.enqueue(raw.id, { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
    } finally {
      await successorMonitor?.stop();
      await oldMonitor.stop();
      resetGatewayWorkAdmission();
    }
  });

  queueIt("isolates activity observer failures from delivery", async (queue) => {
    const observerError = new Error("observer failed");
    const onError = vi.fn();
    const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = createMonitor(
      queue,
      deliver,
      () => {
        throw observerError;
      },
      onError,
    );
    await startWith(monitor, event("event-observer"));
    await monitor.waitForIdle();
    expect(deliver).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(observerError);
    await monitor.stop();
  });

  queueIt("releases unadopted delivery before stop disposes", async (queue) => {
    const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      await waitForAbort(lifecycle.abortSignal);
    });
    const monitor = createMonitor(queue, deliver);
    await startWith(monitor, event("event-stop-retry"));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await monitor.stop();
    await expect(queue.listClaims()).resolves.toEqual([]);
    await expect(queue.listPending()).resolves.toEqual([
      expect.objectContaining({ id: "event-stop-retry", lastError: expect.any(String) }),
    ]);
    await expect(monitor.waitForIdle()).resolves.toBeUndefined();
  });

  it.each(["detached", "inherited"] as const)(
    "keeps delivery admissible after its %s root releases",
    async (root) => {
      await withQueue(async (queue) => {
        const gate = createDeferred();
        const pumpSettled = createDeferred();
        let admissionClosed: boolean | undefined;
        const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          await gate.promise;
          admissionClosed = isGatewaySubordinateWorkAdmissionClosed();
          await lifecycle.onAdopted();
        });
        const detached = root === "detached";
        const monitor = createMonitor(
          queue,
          deliver,
          detached
            ? {
                pollIntervalMs: 10,
                waitForDeliveryIdleBeforeRepump: false,
                runPumpTask: (work) =>
                  runWithGatewayIndependentRootWorkContinuation(work).finally(pumpSettled.resolve),
              }
            : { pollIntervalMs: 60_000 },
        );
        const scan = detached ? undefined : gateNextScan(queue);
        monitor.start();
        try {
          // The admitting root releases before dispatch (inherited) or delivery (detached).
          await runWithGatewayIndependentRootWorkAdmission(async () => {
            await monitor.admit(event(detached ? "event-detached-root" : "event-released-root"));
            if (scan) {
              await scan.started;
            }
          });
          scan?.release();
          await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
          if (detached) {
            await pumpSettled.promise;
          }
          gate.resolve();
          await vi.waitFor(() => expect(admissionClosed).toBeDefined());
          expect(admissionClosed).toBe(false);
          await monitor.waitForIdle();
          expect(await queue.listClaims()).toEqual([]);
          if (detached) {
            expect(await queue.listPending()).toEqual([]);
          }
        } finally {
          gate.resolve();
          scan?.release();
          await monitor.stop();
        }
      });
    },
  );

  it.each([
    { deferred: false, result: "completed", claims: 0 },
    { deferred: true, result: "deferred", claims: 1 },
    { deferred: true, result: "completed", claims: 1 },
  ] as const)(
    "preserves $result on stop with deferred=$deferred",
    async ({ deferred, result, claims }) => {
      await withQueue(async (queue) => {
        const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          if (deferred) {
            lifecycle.onDeferred();
          }
          await waitForAbort(lifecycle.abortSignal);
          return { kind: result };
        });
        const monitor = createMonitor(queue, deliver);
        await startWith(monitor, event("event-stop-result"));
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        await monitor.stop();
        // A recorded handoff retains custody even if the terminal return conflicts.
        expect(await queue.listPending()).toEqual([]);
        if (claims) {
          expect(await queue.listClaims()).toHaveLength(claims);
        } else {
          expect(await queue.listClaims()).toEqual([]);
        }
      });
    },
  );

  queueIt("clears queued drain requests when abort wins", async (queue) => {
    const { promise: pruneStarted, resolve: markPruneStarted } = createDeferred();
    const { promise: pruneGate, resolve: releasePrune } = createDeferred();
    const prune = queue.prune.bind(queue);
    queue.prune = async (...args) => {
      markPruneStarted();
      await pruneGate;
      return await prune(...args);
    };
    const abortController = new AbortController();
    const monitor = createMonitor(queue, vi.fn(), { abortSignal: abortController.signal });
    monitor.start();
    await pruneStarted;
    await monitor.admit(event("event-abort-requested"));
    abortController.abort();
    releasePrune();
    await expect(monitor.waitForIdle()).resolves.toBeUndefined();
    await monitor.stop();
  });

  it.each(["onDeferred", "onAdoptionFinalizing"] as const)(
    "waits for tracked %s claims to settle before drain disposal",
    async (handoff) => {
      await withQueue(async (queue) => {
        let deferredLifecycle: ChannelIngressMonitorLifecycle | undefined;
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            deferredLifecycle = lifecycle;
            lifecycle[handoff]();
          },
          { deferredClaims: "wait-on-stop" },
        );
        await startWith(monitor, event("event-tracked-deferred"));
        await vi.waitFor(() => expect(deferredLifecycle).toBeDefined());
        let stopped = false;
        const stopping = monitor.stop().then(() => {
          stopped = true;
        });
        await vi.waitFor(() => expect(deferredLifecycle?.abortSignal.aborted).toBe(true));
        expect(stopped).toBe(false);
        await deferredLifecycle?.onAbandoned();
        await stopping;
        expect(stopped).toBe(true);
      });
    },
  );

  it.each(
    (["throw", "return"] as const).flatMap((failureMode) =>
      [false, true].map((ownerAborted) => ({ failureMode, ownerAborted })),
    ),
  )(
    "settles tracked finalization after $failureMode with ownerAborted=$ownerAborted",
    async ({ failureMode, ownerAborted }) => {
      await withQueue(async (queue) => {
        const error = new Error("inline finalization failed");
        const abort = new AbortController();
        let finalizingLifecycle: ChannelIngressMonitorLifecycle | undefined;
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            finalizingLifecycle = lifecycle;
            lifecycle.onAdoptionFinalizing();
            if (ownerAborted) {
              abort.abort(error);
            }
            if (failureMode === "throw") {
              throw error;
            }
            return { kind: "failed-retryable", error };
          },
          { deferredClaims: "wait-on-stop", abortSignal: abort.signal },
        );
        await startWith(monitor, event("event-finalization-failure"));
        await monitor.waitForIdle();
        await monitor.pause();
        let settlementFinished = false;
        const settlement = monitor.waitForDeferredClaims().then(() => {
          settlementFinished = true;
        });
        try {
          expect(await queue.listClaims()).toEqual([]);
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            { id: "event-finalization-failure", attempts: 1, lastError: error.message },
          ]);
          await vi.waitFor(() => expect(settlementFinished).toBe(true));
        } finally {
          await finalizingLifecycle?.onAbandoned();
          await settlement;
          await monitor.stop();
        }
      });
    },
  );
  queueIt("keeps opt-in durable admission available after stop", async (queue) => {
    const deliver = vi.fn();
    const retired = createMonitor(queue, deliver, { admissionMode: "durable-after-stop" });
    retired.start();
    await retired.stop();
    await expect(
      retired.admit(event("event-late", "a", "after unregister")),
    ).resolves.toMatchObject({ kind: "durable" });
    expect(deliver).not.toHaveBeenCalled();
    const recovered = createMonitor(queue, deliver);
    recovered.start();
    await recovered.waitForIdle();
    expect(deliver).toHaveBeenCalledOnce();
    await recovered.stop();
  });

  it("fails start once when the durable queue cannot be opened", async () => {
    const denial = new Error("Cannot open the channel ingress database: disk is full");
    const queueFactory = vi.fn((): ChannelIngressQueue<StoredEvent> => {
      throw denial;
    });
    const onError = vi.fn();
    const monitor = createMonitor(queueFactory, vi.fn(), undefined, onError, undefined, 1);
    vi.useFakeTimers();
    try {
      const startError = (() => {
        try {
          monitor.start();
          return expect.unreachable("start must fail while the durable queue is denied");
        } catch (error) {
          return error;
        }
      })();
      expect(startError).toBeInstanceOf(ChannelIngressUnavailableError);
      expect((startError as Error).cause).toBe(denial);
      expect(isChannelIngressUnavailableError(startError)).toBe(true);
      expect(
        isChannelIngressUnavailableError(new Error("slack start failed", { cause: startError })),
      ).toBe(true);
      expect(isChannelIngressUnavailableError(denial)).toBe(false);
      expect(monitor.isRunning()).toBe(false);
      await vi.advanceTimersByTimeAsync(25);
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      const admissionAssertion = expect(monitor.admit(event("event-denied"))).rejects.toBe(denial);
      const timerRun = vi.runAllTimersAsync();
      // A failed assertion can settle first; join the clock driver before restoring timers.
      try {
        await Promise.all([admissionAssertion, timerRun]);
      } finally {
        await timerRun;
      }
    } finally {
      try {
        await monitor.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  queueIt("lets channels own delivery-idle shutdown grace", async (queue) => {
    const delivery = createDeferred();
    const { promise: deliveryStarted, resolve: markDeliveryStarted } = createDeferred();
    const monitor = createMonitor(
      queue,
      async () => {
        markDeliveryStarted();
        await delivery.promise;
      },
      { waitForDeliveryIdleBeforeRepump: false, waitForDeliveryIdleOnStop: false },
    );
    await startWith(monitor, event("event-active"));
    await deliveryStarted;
    await monitor.stop();
    delivery.resolve();
    await monitor.waitForIdle();
  });
});

describe("channel ingress monitor shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["cancel", "adopt", "completed", "failed"] as const)(
    "joins the %s write before disposal without waiting for delivery",
    async (settlementKind) => {
      await withQueue(async (queue) => {
        const started = createDeferred();
        const writeStarted = createDeferred();
        const commit = createDeferred();
        const order: string[] = [];
        const pauseWrite = async (write: () => Promise<boolean>) => {
          writeStarted.resolve();
          await commit.promise;
          const result = await write();
          order.push("committed");
          return result;
        };
        if (settlementKind === "cancel" || settlementKind === "failed") {
          const release = queue.release.bind(queue);
          vi.spyOn(queue, "release").mockImplementation((...args) =>
            pauseWrite(() => release(...args)),
          );
        } else {
          const complete = queue.complete.bind(queue);
          vi.spyOn(queue, "complete").mockImplementation((...args) =>
            pauseWrite(() => complete(...args)),
          );
        }
        let settlement = Promise.resolve();
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            started.resolve();
            if (settlementKind === "completed") {
              return { kind: "completed" };
            }
            if (settlementKind === "failed") {
              return { kind: "failed-retryable", error: new Error("retry delivery") };
            }
            await waitForAbort(lifecycle.abortSignal);
            settlement = Promise.resolve(
              settlementKind === "cancel" ? lifecycle.onCancelled?.() : lifecycle.onAdopted(),
            );
            return { kind: settlementKind === "cancel" ? "deferred" : "completed" };
          },
          {
            deferredClaims: "wait-on-stop",
            waitForDeliveryIdleOnStop: false,
          },
        );
        await startWith(monitor, event("inline-settlement"));
        await started.promise;
        if (settlementKind === "completed" || settlementKind === "failed") {
          await writeStarted.promise;
        }
        const stopping = monitor.stop().then(() => order.push("stopped"));
        const successor = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: async (_claim, lifecycle) => {
            await lifecycle.onAdopted();
          },
        });
        try {
          await writeStarted.promise;
          await monitor.waitForPumpIdle();
          expect(await successor.drainOnce()).toEqual({ started: 0 });
          commit.resolve();
          await Promise.all([settlement, stopping]);
          expect(order).toEqual(["committed", "stopped"]);
          expect(await queue.listClaims()).toEqual([]);
          expect((await queue.listPending()).map((row) => row.id)).toEqual(
            settlementKind === "cancel" || settlementKind === "failed" ? ["inline-settlement"] : [],
          );
        } finally {
          commit.resolve();
          await Promise.allSettled([settlement, stopping]);
          await successor.waitForIdle();
          successor.dispose();
        }
      });
    },
  );
});
