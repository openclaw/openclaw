import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { clearFollowupDrainCallback } from "../../auto-reply/reply/queue/drain.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import { runDetachedWebhookWork } from "../../plugin-sdk/webhook-request-guards.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  isIngressAdoptionLostError,
} from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";

async function deferNext(
  queue: ReturnType<typeof createTestIngressQueue>,
  abortSignal?: AbortSignal,
  adoptionStallTimeoutMs = 1_000,
) {
  const lifecycles: ChannelIngressDispatchLifecycle[] = [];
  const drain = createChannelIngressDrain({
    queue,
    abortSignal,
    adoptionStallTimeoutMs,
    dispatchClaimedEvent: async (_event, lifecycle) => {
      lifecycles.push(lifecycle);
      return { kind: "deferred" };
    },
  });
  await drain.drainOnce();
  await drain.waitForIdle();
  const lifecycle = expectDefined(lifecycles[0], "deferred lifecycle");
  return {
    drain,
    lifecycle,
    heartbeat: expectDefined(lifecycle.onDeferredHeartbeat, "deferred heartbeat"),
  };
}

describe("channel ingress drain watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries pre-adoption stalls in lane order and fences late adoption", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall", { text: "x" }, { laneKey: "l1" });
      await queue.enqueue("evt-next", { text: "next" }, { laneKey: "l1", receivedAt: clock + 1 });
      const dispatched: string[] = [];
      const finishStalledHandler = createDeferredCore();
      const release = vi.spyOn(queue, "release");
      let stalledLifecycle: ChannelIngressDispatchLifecycle | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          if (!stalledLifecycle) {
            stalledLifecycle = lifecycle;
            await finishStalledHandler.promise;
            return;
          }
          await lifecycle.onAdopted();
        },
      });

      await drain.drainOnce();
      const stalledHandler = drain.waitForIdle();
      try {
        clock += 5_000;
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(
          expectDefined(release.mock.results[0]?.value, "watchdog release"),
        ).resolves.toBe(true);

        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all", orderBy: "received" })).toMatchObject([
          { id: "evt-stall", attempts: 1, lastError: expect.stringContaining("handler-timeout") },
          { id: "evt-next", attempts: 0 },
        ]);
        await expect(stalledLifecycle?.onAdopted()).rejects.toSatisfy(isIngressAdoptionLostError);

        expect(await drain.drainOnce()).toEqual({ started: 0 });
        finishStalledHandler.resolve();
        await stalledHandler;
        clock += 1_000;
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await drain.waitForIdle();
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await drain.waitForIdle();
        expect(dispatched).toEqual(["evt-stall", "evt-stall", "evt-next"]);
      } finally {
        finishStalledHandler.resolve();
        await stalledHandler;
        await Promise.allSettled(
          release.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
        drain.dispose();
        release.mockRestore();
      }
    });
  });

  it("keeps adoption finalization paused across deferred heartbeats", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("finalizing", { text: "x" }, { laneKey: "l1" });
      const { drain, lifecycle, heartbeat } = await deferNext(queue);
      lifecycle.onAdoptionFinalizing();
      try {
        await vi.advanceTimersByTimeAsync(333);
        heartbeat();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(lifecycle.abortSignal.aborted).toBe(false);
        expect(await queue.listClaims()).toMatchObject([{ id: "finalizing", attempts: 0 }]);
        await lifecycle.onAdopted();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        drain.dispose();
      }
    });
  });

  it("adopts a dispatching handler that stays live beyond the stall timeout", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("compacting", { text: "x" }, { laneKey: "l1" });
      let dispatchSignal: AbortSignal | undefined;
      const dispatch = vi.fn(
        async (_event: unknown, lifecycle: ChannelIngressDispatchLifecycle) => {
          dispatchSignal = lifecycle.abortSignal;
          const pulse = setInterval(
            expectDefined(lifecycle.onDeferredHeartbeat, "pre-adoption heartbeat"),
            expectDefined(lifecycle.deferredHeartbeatIntervalMs, "heartbeat cadence"),
          );
          try {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 3_500);
            });
            await lifecycle.onAdopted();
          } finally {
            clearInterval(pulse);
          }
        },
      );
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 1_000,
        dispatchClaimedEvent: dispatch,
      });
      try {
        await drain.drainOnce();
        await vi.advanceTimersByTimeAsync(3_500);
        await drain.waitForIdle();
        expect(dispatchSignal?.aborted).toBe(false);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([]);
        expect((await queue.enqueue("compacting", { text: "duplicate" })).kind).toBe("completed");
        expect(await drain.drainOnce()).toEqual({ started: 0 });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        drain.dispose();
      }
    });
  });

  it("rearms a live deferred wait, then guillotines silence", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-stall", { text: "x" }, { laneKey: "l1" });
      const finishDeferredHandler = createDeferredCore();
      const release = vi.spyOn(queue, "release");
      let heartbeat: (() => void) | undefined;
      let heartbeatIntervalMs: number | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.onDeferred();
          heartbeat = lifecycle.onDeferredHeartbeat;
          heartbeatIntervalMs = lifecycle.deferredHeartbeatIntervalMs;
          // Stay deferred without adoption -- watchdog must still fire.
          await finishDeferredHandler.promise;
        },
      });

      await drain.drainOnce();
      const deferredHandler = drain.waitForIdle();
      try {
        expect(await queue.listClaims()).toHaveLength(1);
        expect(heartbeatIntervalMs).toBe(1_666);
        clock += 4_000;
        await vi.advanceTimersByTimeAsync(4_000);
        heartbeat?.();
        clock += 1_000;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await queue.listClaims()).toHaveLength(1);
        clock += 4_000;
        await vi.advanceTimersByTimeAsync(4_000);
        await expect(
          expectDefined(release.mock.results[0]?.value, "watchdog release"),
        ).resolves.toBe(true);

        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          {
            id: "evt-def-stall",
            attempts: 1,
            lastError: expect.stringContaining("handler-timeout"),
          },
        ]);
      } finally {
        finishDeferredHandler.resolve();
        await deferredHandler;
        await Promise.allSettled(
          release.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
        drain.dispose();
        release.mockRestore();
      }
    });
  });

  it.each([
    { stop: "dispose", heartbeat: "late" },
    { stop: "abort", heartbeat: "reentrant" },
  ])("preserves retry facts after $stop (heartbeat: $heartbeat)", async ({ stop, heartbeat }) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("retired", { text: "deferred" }, { laneKey: "lane" });
      const abort = new AbortController();
      const owner = await deferNext(queue, abort.signal);
      try {
        const before = await queue.listClaims();
        expect(before).toHaveLength(1);
        if (heartbeat === "reentrant") {
          owner.lifecycle.abortSignal.addEventListener("abort", owner.heartbeat, { once: true });
        }
        if (stop === "dispose") {
          owner.drain.dispose();
        } else {
          abort.abort(new Error("monitor stopped"));
        }
        expect(owner.lifecycle.abortSignal.aborted).toBe(true);
        const stoppedTimers = vi.getTimerCount();
        if (heartbeat === "late") {
          owner.heartbeat();
        }
        const lateTimers = vi.getTimerCount();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await queue.listClaims()).toEqual(before);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([]);
        expect(lateTimers).toBe(stoppedTimers);

        // A real late adoption still commits; stopping only retires watchdog work.
        await owner.lifecycle.onAdopted();
        expect((await queue.enqueue("retired", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        owner.drain.dispose();
      }
    });
  });

  it.each([
    { terminal: "cancelled", attempts: 0, lastError: undefined },
    { terminal: "abandoned", attempts: 1, lastError: "turn-abandoned" },
    { terminal: "failed", attempts: 1, lastError: "provider failed" },
  ])(
    "records a late $terminal outcome after disposal",
    async ({ terminal, attempts, lastError }) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("terminal", { text: "deferred" }, { laneKey: "lane" });
        const owner = await deferNext(queue);
        try {
          owner.drain.dispose();
          if (terminal === "cancelled") {
            await expectDefined(owner.lifecycle.onCancelled, "cancel callback")();
          } else if (terminal === "abandoned") {
            await owner.lifecycle.onAbandoned();
          } else {
            await expectDefined(
              owner.lifecycle.onFailed,
              "failure callback",
            )(new Error("provider failed"));
          }
          owner.heartbeat();
          await vi.advanceTimersByTimeAsync(1_100);
          expect(await queue.listClaims()).toEqual([]);
          const pending = await queue.listPending();
          expect(pending).toHaveLength(1);
          expect(pending[0]?.attempts).toBe(attempts);
          expect(pending[0]?.lastError).toBe(lastError);
        } finally {
          owner.drain.dispose();
        }
      });
    },
  );

  it("keeps a successor claim fenced from retired callbacks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("replacement", { text: "deferred" }, { laneKey: "lane" });
      const old = await deferNext(queue);
      const retired = await queue.listClaims();
      old.drain.dispose();
      const next = await deferNext(queue, undefined, 60_000);
      try {
        const before = await queue.listClaims();
        expect(before).toHaveLength(1);
        expect(before[0]?.claim.token).not.toBe(retired[0]?.claim.token);
        old.heartbeat();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await queue.listClaims()).toEqual(before);
        expect(await queue.listPending()).toEqual([]);
        await expect(old.lifecycle.onAdopted()).rejects.toSatisfy(isIngressAdoptionLostError);
        await next.lifecycle.onAdopted();
        expect((await queue.enqueue("replacement", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        old.drain.dispose();
        next.drain.dispose();
      }
    });
  });
});

describe("channel ingress drain restart-recovery tombstone", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("does not report a retry after the claim was reclaimed", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
      await queue.enqueue("evt-head", { text: "question" }, { laneKey: "dm" });
      let lifecycle: ChannelIngressDispatchLifecycle | undefined;
      const logs: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        onLog: (message) => logs.push(message),
        dispatchClaimedEvent: (_event, current) => {
          lifecycle = current;
          return { kind: "deferred" };
        },
      });
      try {
        await drain.drainOnce();
        await vi.waitFor(() => expect(lifecycle).toBeDefined());
        expect(await queue.recoverStaleClaims({ staleMs: 0, now: 10_001 })).toBe(1);
        await expectDefined(
          expectDefined(lifecycle, "deferred lifecycle").onFailed,
          "failure callback",
        )(new Error("dispatch failure"));
        expect(await queue.listFailed?.()).toHaveLength(0);
        expect(await queue.listPending()).toHaveLength(1);
        expect(logs.some((message) => message.includes("; keeping for retry:"))).toBe(false);
      } finally {
        drain.dispose();
      }
    });
  });

  it("retains the retried failed head and drains its follower without replay", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
      await queue.enqueue("evt-head", { text: "question" }, { laneKey: "dm", receivedAt: 1 });
      await queue.enqueue("evt-follower", { text: "next" }, { laneKey: "dm", receivedAt: 2 });
      const claim = expectDefined(
        await queue.claim("evt-head", { ownerId: "previous-worker" }),
        "previous claim",
      );
      await queue.release(claim, { lastError: "temporary failure", releasedAt: 10 });
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => 10_000,
        deferredLaneOccupancy: "release",
        dispatchClaimedEvent: async (event, lifecycle) => {
          lifecycles.set(event.id, lifecycle);
          return { kind: "deferred" };
        },
      });
      try {
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await vi.waitFor(() => expect([...lifecycles.keys()]).toEqual(["evt-head"]));
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: "evt-follower", attempts: 0 },
        ]);
        const error = new Error("reply admission refused", {
          cause: Object.assign(new Error("terminal generation"), {
            code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
          }),
        });
        await expectDefined(
          expectDefined(lifecycles.get("evt-head"), "head lifecycle").onFailed,
          "head failure lifecycle",
        )(error);
        const expectedFailed = [
          {
            id: "evt-head",
            channelId: "test",
            accountId: "a",
            queueName: JSON.stringify(["test", "a"]),
            laneKey: "dm",
            payload: { text: "question" },
            receivedAt: 1,
            // Each transition (prior claim and release, then claim and fail)
            // moves updatedAt strictly past the frozen clock.
            updatedAt: 10_004,
            attempts: 1,
            lastAttemptAt: 10,
            failedAt: 10_000,
            reason: "restart-recovery-tombstone",
            message:
              "reply admission refused | terminal generation | SESSION_RESTART_RECOVERY_TOMBSTONE",
          },
        ];
        expect(await queue.listFailed?.({ limit: "all" })).toEqual(expectedFailed);
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await vi.waitFor(() =>
          expect([...lifecycles.keys()]).toEqual(["evt-head", "evt-follower"]),
        );
        await expectDefined(lifecycles.get("evt-follower"), "follower lifecycle").onAdopted();
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
        drain.dispose();
        closeOpenClawStateDatabaseForTest();

        const reopened = createTestIngressQueue(stateDir, { now: () => 20_000 });
        const dispatchAfterRestart = vi.fn(async () => {});
        const restarted = createChannelIngressDrain({
          queue: reopened,
          dispatchClaimedEvent: dispatchAfterRestart,
        });
        try {
          expect(await restarted.recoverStaleClaims()).toBe(0);
          expect(await restarted.drainOnce()).toEqual({ started: 0 });
          expect(await reopened.enqueue("evt-head", { text: "question" })).toMatchObject({
            kind: "failed",
            duplicate: true,
          });
          expect(await reopened.enqueue("evt-follower", { text: "next" })).toMatchObject({
            kind: "completed",
            duplicate: true,
          });
          expect(await restarted.drainOnce()).toEqual({ started: 0 });
          expect(dispatchAfterRestart).not.toHaveBeenCalled();
          expect(await reopened.listFailed?.({ limit: "all" })).toEqual(expectedFailed);
        } finally {
          restarted.dispose();
        }
      } finally {
        drain.dispose();
      }
    });
  });
});

describe("channel ingress drain debounce failures", () => {
  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries a pre-admission failure without waiting for the watchdog", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "debounced-retry",
        { text: "retry me" },
        {
          laneKey: "shared",
          receivedAt: clock,
        },
      );
      const sessionError = new Error("Session changed while starting work. Retry.");
      const reportedErrors: unknown[] = [];
      let attempt = 0;
      const debouncer = createInboundDebouncer<{ lifecycle: ChannelIngressDispatchLifecycle }>({
        debounceMs: 0,
        buildKey: () => "shared",
        onFlush: (entries, createFlush) =>
          createFlush({
            lifecycle: entries[0]?.lifecycle,
            dispatch: async (lifecycle) => {
              attempt += 1;
              if (attempt === 1) {
                throw sessionError;
              }
              await lifecycle.onAdopted();
            },
          }),
        onError: (error) => reportedErrors.push(error),
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await debouncer.enqueue({ lifecycle });
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: "debounced-retry", attempts: 1, lastError: sessionError.message },
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);

      clock += 1_000;
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      await debouncer.drain();

      expect(attempt).toBe(2);
      expect(reportedErrors).toEqual([sessionError]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.enqueue("debounced-retry", { text: "retry me" })).toMatchObject({
        kind: "completed",
      });
      drain.dispose();
    });
  });

  it("keeps watchdog ownership when retry settlement keeps failing", async () => {
    vi.useFakeTimers();
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "debounced-settlement-failure",
        { text: "retry me" },
        { laneKey: "shared", receivedAt: clock },
      );
      queue.release = async () => {
        throw new Error("persistent release failure");
      };
      const log = vi.fn();

      const sessionError = new Error("Session changed while starting work. Retry.");
      const debouncer = createInboundDebouncer<{ lifecycle: ChannelIngressDispatchLifecycle }>({
        debounceMs: 0,
        buildKey: () => "shared",
        onFlush: (entries, createFlush) =>
          createFlush({
            lifecycle: entries[0]?.lifecycle,
            dispatch: async () => {
              throw sessionError;
            },
          }),
        onError: () => undefined,
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 200_000,
        onLog: log,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await debouncer.enqueue({ lifecycle });
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.advanceTimersByTimeAsync(127_000);
      clock += 127_000;
      await drain.waitForIdle();

      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
        "debounced-settlement-failure",
      ]);
      expect(drain.activeLaneKeys().has("shared")).toBe(true);

      clock += 73_000;
      await vi.advanceTimersByTimeAsync(73_000);
      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
        "debounced-settlement-failure",
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(drain.activeLaneKeys().has("shared")).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("applying retry policy (handler-timeout)"),
      );
      drain.dispose();
    });
  });
});

describe("channel ingress drain async work ownership", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("tracks a monitor delivery after its webhook pump closes and a queued followup after delivery settles", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const turnGate = createDeferredCore();
      const followupGate = createDeferredCore();
      const followupFinished = createDeferredCore();
      const pumpSignals: AbortSignal[] = [];
      const events: string[] = [];
      const followupKey = `ingress-async-work:${stateDir}`;
      const monitor = createChannelIngressMonitor<Payload, Payload, Payload>({
        queue,
        inspect: (raw) => ({ eventId: raw.text, laneKey: "lane-a" }),
        payload: {
          version: 1,
          serialize: (raw) => raw,
          deserialize: (raw) => raw,
          encode: ({ body }) => body,
          decode: (body) => ({ version: 1, body }),
          createClaimError: (kind) => new Error(kind),
        },
        pollIntervalMs: 60_000,
        retention: "standard",
        runPumpTask: (work) =>
          runDetachedWebhookWork(async () => {
            const signal = getAsyncWorkSignal();
            expect(signal).toBeDefined();
            if (signal) {
              pumpSignals.push(signal);
            }
            await work();
          }),
        deliver: async (_raw, lifecycle) => {
          await turnGate.promise;
          await trackAsyncWork(() => events.push("turn"));
          enqueueFollowupRun(followupKey, createQueueTestRun({ prompt: "followup" }), {
            mode: "followup",
            debounceMs: 0,
          });
          scheduleFollowupDrain(followupKey, async () => {
            try {
              await followupGate.promise;
              await trackAsyncWork(() => events.push("followup"));
            } finally {
              followupFinished.resolve();
            }
          });
          await lifecycle.onAdopted();
        },
      });

      try {
        await monitor.admit({ text: "evt-scope" });
        monitor.start();
        await monitor.waitForPumpIdle();
        await vi.waitFor(() => expect(pumpSignals[0]?.aborted).toBe(true));
        expect(events).toEqual([]);

        turnGate.resolve();
        await monitor.waitForIdle();
        expect(events).toEqual(["turn"]);
        await expect(queue.listPending()).resolves.toEqual([]);
        await expect(queue.listClaims()).resolves.toEqual([]);

        followupGate.resolve();
        await followupFinished.promise;
        expect(events).toEqual(["turn", "followup"]);
      } finally {
        turnGate.resolve();
        followupGate.resolve();
        await monitor.stop();
        clearFollowupQueue(followupKey);
        clearFollowupDrainCallback(followupKey);
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      }
    });
  });
});
