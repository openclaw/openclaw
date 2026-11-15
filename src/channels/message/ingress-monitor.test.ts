import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForAbortSignal as waitForAbort } from "../../infra/abort-signal.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import { createOwnershipRecord } from "../../plugins/registry-ownership.test-support.js";
import { createRuntimeTestRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createChannelIngressError } from "./ingress-errors.js";
import {
  CHANNEL_INGRESS_RETENTION_DEFAULTS,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import {
  createMonitor,
  useIngressMonitorQueueFixture,
  type RawEvent,
  type StoredEvent,
} from "./ingress-monitor.test-harness.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";
import {
  ChannelIngressUnavailableError,
  isChannelIngressUnavailableError,
} from "./ingress-unavailable.js";

const withQueue = useIngressMonitorQueueFixture();
afterEach(() => vi.useRealTimers());

describe("channel ingress monitor", () => {
  it("reports a direct delivery as active before a synchronous transport failure", async () => {
    await withQueue(async (queue) => {
      const activity: boolean[] = [];
      const monitor = createMonitor(queue, vi.fn(), (active) => activity.push(active));
      const failure = new Error("direct dispatch failed");
      let activeAtDispatch: boolean | undefined;
      await expect(
        monitor.dispatchDirect(() => {
          activeAtDispatch = activity.at(-1);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(activeAtDispatch).toBe(true);
      expect(activity.at(-1)).toBe(false);
    });
  });

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

  it("applies standard retention with explicit per-channel overrides", async () => {
    for (const [retention, completedMaxEntries] of [
      ["standard", 20_000],
      [{ completedMaxEntries: 1_000 }, 1_000],
    ] as const) {
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
    }
  });

  it.each(["single", "batch"] as const)("prunes once before %s admission", async (mode) => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const enqueue = vi.spyOn(queue, mode === "single" ? "enqueue" : "enqueueBatch");
      const monitor = createMonitor(queue, vi.fn(), {
        inspect: (raw) =>
          raw.id === "ignored" ? null : { eventId: raw.id, laneKey: `lane:${raw.lane}` },
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });
      vi.useFakeTimers();
      monitor.start();
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(300_000);
      await monitor.pause();
      expect(prune).not.toHaveBeenCalled();
      const ignored = { id: "ignored", lane: "a", text: "receipt" };
      await expect(monitor.admit(ignored)).resolves.toEqual({ kind: "ignored" });
      expect(prune).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      const first = { id: "event-first", lane: "a", text: "first" };
      if (mode === "single") {
        await monitor.admit(first);
      } else {
        await monitor.admitBatch([
          ignored,
          first,
          { id: "event-second", lane: "b", text: "second" },
          { id: "event-third", lane: "c", text: "third" },
        ]);
      }
      expect(prune).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledOnce();
      expect((await queue.listPending()).map((row) => row.id)).toEqual(
        mode === "single" ? ["event-first"] : ["event-first", "event-second", "event-third"],
      );
      expect(Math.max(...prune.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...enqueue.mock.invocationCallOrder),
      );
      await monitor.stop();
    });
  });

  it("recovers the entire committed batch after an acknowledgment fails", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, vi.fn(), {
        onDurableAdmission: () => {
          throw new Error("lost acknowledgment");
        },
      });
      await expect(
        monitor.admitBatch([
          { id: "first", lane: "a", text: "one" },
          { id: "second", lane: "a", text: "two" },
        ]),
      ).rejects.toThrow("lost acknowledgment");
      await monitor.stop();

      const delivered: string[] = [];
      const restarted = createMonitor(queue, (raw) => {
        delivered.push(raw.id);
      });
      restarted.start();
      await restarted.waitForIdle();
      await restarted.stop();
      expect(delivered).toEqual(["first", "second"]);
      expect(await queue.listPending()).toEqual([]);
    });
  });

  it("dead-letters a claim whose decoded lane identity changed", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "event-original",
        {
          version: 1,
          rawEvent: JSON.stringify({ id: "event-original", lane: "changed", text: "hello" }),
        },
        { laneKey: "lane:original" },
      );
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
  });
  it.each([
    { kind: "legacy", storedLaneKey: undefined, schedulingLaneKey: "lane:a" },
    { kind: "per-event", storedLaneKey: "lane:a", schedulingLaneKey: "lane:a:event-derived" },
  ])(
    "preserves transport identity with a $kind scheduling lane",
    async ({ storedLaneKey, schedulingLaneKey }) => {
      await withQueue(async (queue) => {
        await queue.enqueue(
          "event-derived",
          {
            version: 1,
            rawEvent: JSON.stringify({ id: "event-derived", lane: "a", text: "hello" }),
          },
          { laneKey: storedLaneKey },
        );
        const deliver = vi.fn();
        const monitor = createMonitor(queue, deliver, {
          deriveLaneKey: () => schedulingLaneKey,
        });
        monitor.start();
        await monitor.waitForIdle();

        expect(deliver).toHaveBeenCalledOnce();
        await monitor.stop();
      });
    },
  );

  it("drains the next same-lane event after adoption while delivery remains active", async () => {
    await withQueue(async (queue) => {
      const { promise: firstDone, resolve: releaseFirst } = createDeferred();
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        await lifecycle.onAdopted();
        if (raw.id === "event-first") {
          await firstDone;
        }
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "a", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("re-arms a coalesced idle wake for a later retryable delivery", async () => {
    await withQueue(async (queue) => {
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
        undefined,
        undefined,
        undefined,
        60_000,
        0,
      );
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "first", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));
      await monitor.admit({ id: "event-retry", lane: "retry", text: "retry" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-retry"]));

      releaseFirst();
      await vi.waitFor(async () =>
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["event-retry"]),
      );
      releaseRetry();
      await vi.waitFor(() =>
        expect(delivered).toEqual(["event-first", "event-retry", "event-retry"]),
      );
      await monitor.waitForIdle();

      await monitor.stop();
    });
  });

  // Telegram and Slack release the ingress lane while a turn is deferred, so a
  // newer same-lane event can be claimed and fail while the older one is still
  // held. Cancelling that deferred owner reopens its row without consuming retry
  // budget, leaving an eligible lane head behind its own newer sibling's backoff.
  it("dispatches a reopened lane head while its newer sibling waits out backoff", async () => {
    await withQueue(async (queue) => {
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
      monitor.start();
      await monitor.admit({ id: "event-head", lane: "a", text: "head" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-head"]));
      await monitor.admit({ id: "event-tail", lane: "a", text: "tail" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail"]));
      // The failed tail is pending inside its backoff; the head is still claimed.
      await vi.waitFor(async () =>
        expect(
          (await queue.listPending({ limit: "all", orderBy: "received" })).map((event) => event.id),
        ).toEqual(["event-tail"]),
      );

      expect(cancelHead).toBeDefined();
      await cancelHead?.();

      await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail", "event-head"]));
      await monitor.waitForIdle();
      // The tail still never starts early: it stays parked for its own backoff.
      expect(delivered).toEqual(["event-head", "event-tail", "event-head"]);

      await monitor.stop();
    });
  });

  it("defers a claimed event across restart drain without consuming retry budget", async () => {
    await withQueue(async (queue) => {
      const event = {
        id: "event-restart-drain",
        lane: "a",
        text: "recover me",
      } satisfies RawEvent;
      const storedEvent: StoredEvent = { version: 1, rawEvent: JSON.stringify(event) };
      const drainErrors: unknown[] = [];
      const { promise: deliveryStarted, resolve: markDeliveryStarted } = createDeferred();
      const { promise: deliveryGate, resolve: releaseDelivery } = createDeferred();
      const oldDeliver = vi.fn(
        async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          markDeliveryStarted();
          await deliveryGate;
          try {
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await lifecycle.onAdopted();
            });
          } catch (error) {
            drainErrors.push(error);
            throw error;
          }
        },
      );
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

        await queue.enqueue(event.id, storedEvent, { laneKey: "lane:a" });
        oldMonitor.requestDrain();
        await deliveryStarted;
        markGatewayRestartDraining();
        releaseDelivery();
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
          expect.objectContaining({ id: event.id, attempts: 0 }),
        ]);
        await expect(queue.listFailed?.()).resolves.toEqual([]);

        await oldMonitor.stop();
        resetGatewayWorkAdmission();
        const successorDeliver = vi.fn(
          async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await lifecycle.onAdopted();
            });
          },
        );
        successorMonitor = createMonitor(queue, successorDeliver, monitorOptions);
        successorMonitor.start();
        await successorMonitor.waitForIdle();

        expect(successorDeliver).toHaveBeenCalledOnce();
        expect(oldDeliver).toHaveBeenCalledOnce();
        await expect(
          queue.enqueue(event.id, { version: 1, rawEvent: "duplicate" }),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        releaseDelivery();
        await successorMonitor?.stop();
        await oldMonitor.stop();
        resetGatewayWorkAdmission();
      }
    });
  });

  it("isolates activity observer failures from delivery bookkeeping", async () => {
    await withQueue(async (queue) => {
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
      monitor.start();

      await monitor.admit({ id: "event-observer", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(observerError);
      await monitor.stop();
    });
  });

  it.each(["detached", "released"] as const)(
    "keeps delivery admissible after its %s pump root closes",
    async (mode) => {
      await withQueue(async (queue) => {
        const entered = createDeferredCore();
        const deliverGate = createDeferredCore();
        const scanStarted = createDeferredCore();
        const scanGate = createDeferredCore();
        let admissionClosedDuringDelivery: boolean | undefined;
        const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          entered.resolve();
          await deliverGate.promise;
          admissionClosedDuringDelivery = isGatewaySubordinateWorkAdmissionClosed();
          await lifecycle.onAdopted();
        });
        if (mode === "released") {
          const listUnsettled = queue.listUnsettled!.bind(queue);
          let gateNextScan = true;
          queue.listUnsettled = async (...args) => {
            if (gateNextScan) {
              gateNextScan = false;
              scanStarted.resolve();
              await scanGate.promise;
            }
            return await listUnsettled(...args);
          };
        }
        const monitor = createMonitor(queue, deliver, {
          runPumpTask:
            mode === "detached" ? runWithGatewayIndependentRootWorkContinuation : undefined,
        });
        monitor.start();
        try {
          await runWithGatewayIndependentRootWorkAdmission(async () => {
            await monitor.admit({ id: "event-root", lane: "a", text: "hello" });
            if (mode === "released") {
              await scanStarted.promise;
            }
          });
          // The released case cannot claim until the admitting root has closed.
          scanGate.resolve();
          await entered.promise;
          expect(deliver).toHaveBeenCalledOnce();
          await monitor.waitForPumpIdle();
          deliverGate.resolve();
          await monitor.waitForIdle();
          expect(admissionClosedDuringDelivery).toBe(false);
          expect(await queue.listPending()).toEqual([]);
          expect(await queue.listClaims()).toEqual([]);
        } finally {
          deliverGate.resolve();
          scanGate.resolve();
          await monitor.stop();
        }
      });
    },
  );

  it.each([
    ["retry", false, undefined],
    ["completed", false, "completed"],
    ["deferred", true, "deferred"],
    ["conflicting completed", true, "completed"],
  ] as const)(
    "preserves %s ownership when stop races the return",
    async (_name, handoff, result) => {
      await withQueue(async (queue) => {
        const entered = createDeferredCore();
        const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          if (handoff) {
            lifecycle.onDeferred();
          }
          entered.resolve();
          await waitForAbort(lifecycle.abortSignal);
          return result ? { kind: result } : undefined;
        });
        const monitor = createMonitor(queue, deliver);
        monitor.start();
        await monitor.admit({ id: "event-stop", lane: "a", text: "hello" });
        await entered.promise;
        expect(deliver).toHaveBeenCalledOnce();
        await monitor.stop();
        expect(await queue.listPending()).toEqual(
          result
            ? []
            : [expect.objectContaining({ id: "event-stop", lastError: expect.any(String) })],
        );
        // A deferred handoff wins even over a conflicting completed return.
        expect(await queue.listClaims()).toHaveLength(handoff ? 1 : 0);
        await expect(monitor.waitForIdle()).resolves.toBeUndefined();
      });
    },
  );

  it("clears a queued drain request when abort wins an active pump", async () => {
    await withQueue(async (queue) => {
      const { promise: pruneStarted, resolve: markPruneStarted } = createDeferred();
      const { promise: pruneGate, resolve: releasePrune } = createDeferred();
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        markPruneStarted();
        await pruneGate;
        return await prune(...args);
      };
      const abortController = new AbortController();
      const monitor = createMonitor(queue, vi.fn(), undefined, undefined, abortController.signal);
      monitor.start();
      await pruneStarted;

      await monitor.admit({ id: "event-abort-requested", lane: "a", text: "hello" });
      abortController.abort();
      releasePrune();

      await expect(monitor.waitForIdle()).resolves.toBeUndefined();
      await monitor.stop();
    });
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
        monitor.start();
        await monitor.admit({ id: "event-tracked-deferred", lane: "a", text: "hello" });
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
        monitor.start();
        await monitor.admit({ id: "event-finalization-failure", lane: "a", text: "hello" });
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
  it("keeps append-only admission available after stop when explicitly requested", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn();
      const retired = createMonitor(queue, deliver, { admissionMode: "durable-after-stop" });
      retired.start();
      await retired.stop();

      await expect(
        retired.admit({ id: "event-late", lane: "a", text: "after unregister" }),
      ).resolves.toMatchObject({ kind: "durable" });
      expect(deliver).not.toHaveBeenCalled();

      const recovered = createMonitor(queue, deliver);
      recovered.start();
      await recovered.waitForIdle();
      expect(deliver).toHaveBeenCalledOnce();
      await recovered.stop();
    });
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
      // The typed rethrow is the gateway's only way to tell dead inbound apart from
      // an ordinary channel crash; the denial stays reachable as the cause.
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
      // An armed poll timer would have retried the denied factory many times over this window.
      await vi.advanceTimersByTimeAsync(25);
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();

      const admissionAssertion = expect(
        monitor.admit({ id: "event-denied", lane: "a", text: "hello" }),
      ).rejects.toBe(denial);
      const timerRun = vi.runAllTimersAsync();
      // A failed assertion can settle first; join the clock driver before restoring timers.
      try {
        await Promise.all([admissionAssertion, timerRun]);
      } finally {
        await timerRun;
      }
    } finally {
      await monitor.stop();
    }
  });

  it("can defer delivery-idle waiting to a channel-owned shutdown grace", async () => {
    await withQueue(async (queue) => {
      const deliveryGate = createDeferredCore();
      const { promise: deliveryStarted, resolve: markDeliveryStarted } = createDeferred();
      const monitor = createMonitor(
        queue,
        async () => {
          markDeliveryStarted();
          await deliveryGate.promise;
        },
        { waitForDeliveryIdleBeforeRepump: false, waitForDeliveryIdleOnStop: false },
      );
      monitor.start();
      await monitor.admit({ id: "event-active", lane: "a", text: "hello" });
      await deliveryStarted;

      await monitor.stop();
      deliveryGate.resolve();
      await monitor.waitForIdle();
    });
  });
});

describe("channel ingress monitor shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each(["cancel", "adopt", "completed", "failed"] as const)(
    "joins the %s write before disposal with channel-owned delivery waiting",
    async (settlementKind) => {
      await withQueue(async (queue) => {
        const started = createDeferredCore();
        const writeStarted = createDeferredCore();
        const commit = createDeferredCore();
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
        monitor.start();
        await monitor.admit({ id: "inline-settlement", lane: "a", text: "hello" });
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

it.each([
  "failure",
  "implicit",
  "inspection",
  "heartbeat",
  "resume",
  "late",
  "late-start",
  "abort",
  "direct",
] as const)("retains monitor custody across %s without granting fresh delivery", async (mode) => {
  await withStateDirEnv("ingress-plugin-", async ({ stateDir }) => {
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createOwnershipRecord("test", { origin: "bundled" });
    const api = builder.createApi(record, { config: {} });
    const owner = getPluginInstance(record)!;
    markPluginRegistryActive(builder.registry);
    const service = owner.retainConsumer();
    const abort = new AbortController();
    const openQueue = () => api.runtime.state.openChannelIngressQueue<StoredEvent>({ stateDir });
    const runtimeQueue = openQueue();
    const queue = mode === "inspection" || mode === "late" ? openQueue : runtimeQueue;
    const refresh = vi.spyOn(runtimeQueue, "refreshClaim");
    const inspector = createChannelIngressQueue<StoredEvent>({ channelId: "test", stateDir });
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const seen: string[] = [];
    const errors: unknown[] = [];
    let lateLifecycle: ChannelIngressMonitorLifecycle | undefined;
    let directDelivery: Promise<void> | undefined;
    const monitor = owner.run(() =>
      createMonitor(
        queue,
        async (raw, lifecycle) => {
          seen.push(raw.id);
          if (raw.id !== "first") {
            return undefined;
          }
          entered.resolve();
          if (mode === "heartbeat" || mode === "late") {
            lateLifecycle = lifecycle;
            lifecycle.onAdoptionFinalizing();
            return { kind: "deferred" };
          }
          await finish.promise;
          if (mode === "failure") {
            throw new Error("delivery failed");
          }
          return undefined;
        },
        {
          admissionMode: mode === "late-start" ? "while-running" : "durable-after-stop",
          // Direct listeners must join even when the channel owns durable-delivery grace.
          waitForDeliveryIdleOnStop: mode !== "direct",
          abortSignal: abort.signal,
          inspectAsync: async (raw, context) => {
            if (mode === "inspection" && context.phase === "claim" && raw.id === "first") {
              entered.resolve();
              await finish.promise;
            }
            return { eventId: raw.id, laneKey: `lane:${raw.lane}` };
          },
          onError: (error) => errors.push(error),
        },
      ),
    );
    try {
      if (mode === "late-start") {
        monitor.start();
      }
      if (mode === "direct") {
        directDelivery = service.run(() =>
          monitor.dispatchDirect(async () => {
            entered.resolve();
            await finish.promise;
            seen.push("direct");
          }),
        );
      } else {
        await monitor.admit({ id: "first", lane: "a", text: "first" });
      }
      vi.useFakeTimers();
      monitor.start();
      await entered.promise;
      await monitor.waitForPumpIdle();
      owner.quiesce();
      if (mode === "direct") {
        // Retained service authority can finish accepted work, but cannot admit
        // a fresh interaction after this exact plugin instance quiesces.
        await expect(
          service.run(() =>
            monitor.dispatchDirect(async () => {
              seen.push("unexpected-direct");
            }),
          ),
        ).rejects.toThrow();
        const stopping = monitor.stop().then(() => seen.push("stopped"));
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual([]);
        finish.resolve();
        await Promise.all([directDelivery, stopping]);
        expect(seen).toEqual(["direct", "stopped"]);
      } else if (mode === "late-start") {
        finish.resolve();
        await monitor.pause();
        service.run(() => monitor.start());
        owner.resume();
        expect(monitor.isRunning()).toBe(true);
        await service.run(() => monitor.admit({ id: "next", lane: "b", text: "next" }));
        await monitor.waitForIdle();
        expect(seen).toEqual(["first", "next"]);
      } else if (mode === "abort") {
        finish.resolve();
        await monitor.waitForIdle();
        service.release();
        abort.abort();
        let disposed = false;
        const disposal = owner.dispose().then(() => {
          disposed = true;
        });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(disposed).toBe(true);
        await disposal;
      } else if (mode === "resume") {
        await service.run(() => monitor.admit({ id: "next", lane: "b", text: "next" }));
        await monitor.waitForPumpIdle();
        expect(seen).not.toContain("next");
        owner.resume();
        finish.resolve();
        await monitor.waitForIdle();
        expect(seen).toEqual(["first", "next"]);
      } else if (mode === "heartbeat") {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(refresh).toHaveBeenCalled();
        await expect(Promise.all(refresh.mock.results.map(({ value }) => value))).resolves.toEqual([
          true,
        ]);
        expect(errors).toEqual([]);
      } else if (mode !== "late") {
        finish.resolve();
        await vi.advanceTimersByTimeAsync(130_000);
        await monitor.waitForIdle();
        expect((await inspector.listClaims()).map((row) => row.id)).toEqual([]);
      }
      await expect(monitor.stop()).resolves.toBeUndefined();
      if (mode === "late") {
        await service.run(() => lateLifecycle?.onCancelled?.());
        expect(await inspector.listClaims()).toEqual([]);
        await expect(
          monitor.admit({ id: "unauthorized", lane: "c", text: "late" }),
        ).rejects.toThrow();
        await service.run(() => monitor.admit({ id: "late", lane: "c", text: "late" }));
        expect((await inspector.listPending()).map((row) => row.id)).toContain("late");
      }
    } finally {
      finish.resolve();
      await Promise.allSettled([monitor.stop(), directDelivery]);
      service.release();
      await owner.dispose();
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
