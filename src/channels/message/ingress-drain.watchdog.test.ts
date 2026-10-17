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
import { withDrainFixture } from "./ingress-drain-suite.test-support.js";
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  isIngressAdoptionLostError,
} from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
} from "./ingress-drain.test-helpers.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
  }
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

async function deferNext(
  fixture: Parameters<Parameters<typeof withDrainFixture>[0]>[0],
  abortSignal?: AbortSignal,
  adoptionStallTimeoutMs = 1_000,
) {
  const drain = fixture.createDrain({
    abortSignal,
    adoptionStallTimeoutMs,
    dispatchClaimedEvent: async () => ({ kind: "deferred" }),
  });
  await drain.drainOnce();
  await drain.waitForIdle();
  const lifecycle = expectDefined(fixture.lifecycles.at(-1), "deferred lifecycle");
  return {
    drain,
    lifecycle,
    heartbeat: expectDefined(lifecycle.onDeferredHeartbeat, "deferred heartbeat"),
  };
}

async function withDeferred(
  id: string,
  run: (
    queue: ReturnType<typeof createTestIngressQueue>,
    owner: Awaited<ReturnType<typeof deferNext>>,
    abort: AbortController,
    fixture: Parameters<typeof deferNext>[0],
  ) => Promise<void>,
) {
  await withDrainFixture(async (fixture) => {
    await fixture.enqueue(id, "deferred", "lane");
    const abort = new AbortController();
    await run(fixture.queue, await deferNext(fixture, abort.signal), abort, fixture);
  });
}

async function expectEmpty(queue: ReturnType<typeof createTestIngressQueue>) {
  expect(
    await Promise.all([queue.listClaims(), queue.listPending(), queue.listFailed?.()]),
  ).toEqual([[], [], []]);
}

describe("channel ingress drain watchdog", () => {
  beforeEach(() => vi.useFakeTimers());

  it.each([false, true])("times out silent handlers (deferred: %s)", async (deferred) => {
    let clock = deferred ? 30_000 : 10_000;
    await withDrainFixture(
      async ({ queue, enqueue, createDrain, dispatches, lifecycles }) => {
        const id = deferred ? "evt-def-stall" : "evt-stall";
        await enqueue(id, "x", "l1");
        if (!deferred) {
          await enqueue("evt-next", "next", "l1", clock + 1);
        }
        const gate = createDeferredCore();
        const release = vi.spyOn(queue, "release");
        const drain = createDrain({
          adoptionStallTimeoutMs: 5_000,
          ...(deferred ? {} : { retryPolicy: { baseMs: 1_000, maxMs: 1_000 } }),
          dispatchClaimedEvent: async (_event, lifecycle) => {
            if (lifecycles.length === 1) {
              if (deferred) {
                lifecycle.onDeferred();
              }
              await gate.promise;
            } else {
              await lifecycle.onAdopted();
            }
          },
        });
        const advance = async (ms: number) => {
          clock += ms;
          await vi.advanceTimersByTimeAsync(ms);
        };
        await drain.drainOnce();
        const handler = drain.waitForIdle();
        const lifecycle = expectDefined(lifecycles[0], "stalled lifecycle");
        try {
          if (deferred) {
            expect(await queue.listClaims()).toHaveLength(1);
            expect(lifecycle.deferredHeartbeatIntervalMs).toBe(1_666);
            await advance(4_000);
            lifecycle.onDeferredHeartbeat?.();
            await advance(1_000);
            expect(await queue.listClaims()).toHaveLength(1);
            await advance(4_000);
          } else {
            await advance(5_000);
          }
          await expect(
            expectDefined(release.mock.results[0]?.value, "watchdog release"),
          ).resolves.toBe(true);
          expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
          expect(await queue.listPending({ limit: "all", orderBy: "received" })).toMatchObject([
            { id, attempts: 1, lastError: expect.stringContaining("handler-timeout") },
            ...(!deferred ? [{ id: "evt-next", attempts: 0 }] : []),
          ]);
          if (!deferred) {
            await expect(lifecycle.onAdopted()).rejects.toSatisfy(isIngressAdoptionLostError);
            expect(await drain.drainOnce()).toEqual({ started: 0 });
            gate.resolve();
            await handler;
            clock += 1_000;
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await drain.waitForIdle();
            expect(await drain.drainOnce()).toEqual({ started: 1 });
            await drain.waitForIdle();
            expect(dispatches).toEqual(["evt-stall", "evt-stall", "evt-next"]);
          }
        } finally {
          gate.resolve();
          await handler;
          await Promise.allSettled(
            release.mock.results.flatMap((r) => (r.type === "return" ? [r.value] : [])),
          );
          drain.dispose();
          release.mockRestore();
        }
      },
      () => clock,
    );
  });

  it("keeps adoption finalization paused across deferred heartbeats", async () => {
    await withDeferred("finalizing", async (queue, { lifecycle, heartbeat }) => {
      lifecycle.onAdoptionFinalizing();
      await vi.advanceTimersByTimeAsync(333);
      heartbeat();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(lifecycle.abortSignal.aborted).toBe(false);
      expect(await queue.listClaims()).toMatchObject([{ id: "finalizing", attempts: 0 }]);
      await lifecycle.onAdopted();
      await expectEmpty(queue);
    });
  });

  it("adopts a dispatching handler that stays live beyond the stall timeout", async () => {
    await withDrainFixture(async ({ queue, enqueue, createDrain, lifecycles, dispatches }) => {
      await enqueue("compacting", "x", "l1");
      const drain = createDrain({
        adoptionStallTimeoutMs: 1_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
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
      });
      await drain.drainOnce();
      await vi.advanceTimersByTimeAsync(3_500);
      await drain.waitForIdle();
      expect(lifecycles[0]?.abortSignal.aborted).toBe(false);
      await expectEmpty(queue);
      expect((await queue.enqueue("compacting", { text: "duplicate" })).kind).toBe("completed");
      expect(await drain.drainOnce()).toEqual({ started: 0 });
      expect(dispatches).toEqual(["compacting"]);
    });
  });

  it.each([
    { stop: "dispose", heartbeat: "late" },
    { stop: "abort", heartbeat: "reentrant" },
  ])("preserves retry facts after $stop (heartbeat: $heartbeat)", async ({ stop, heartbeat }) => {
    await withDeferred("retired", async (queue, owner, abort) => {
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
      expect([await queue.listPending(), await queue.listFailed?.()]).toEqual([[], []]);
      expect(lateTimers).toBe(stoppedTimers);

      await owner.lifecycle.onAdopted();
      expect((await queue.enqueue("retired", { text: "duplicate" })).kind).toBe("completed");
    });
  });

  it.each([
    { terminal: "cancelled", attempts: 0, lastError: undefined },
    { terminal: "abandoned", attempts: 1, lastError: "turn-abandoned" },
    { terminal: "failed", attempts: 1, lastError: "provider failed" },
  ])(
    "records a late $terminal outcome after disposal",
    async ({ terminal, attempts, lastError }) => {
      await withDeferred("terminal", async (queue, owner) => {
        owner.drain.dispose();
        if (terminal === "cancelled") {
          await expectDefined(owner.lifecycle.onCancelled, "cancel callback")();
        } else if (terminal === "abandoned") {
          await owner.lifecycle.onAbandoned();
        } else {
          const fail = expectDefined(owner.lifecycle.onFailed, "failure callback");
          await fail(new Error("provider failed"));
        }
        owner.heartbeat();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await queue.listClaims()).toEqual([]);
        const pending = await queue.listPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ attempts, lastError });
      });
    },
  );

  it("keeps a successor claim fenced from retired callbacks", async () => {
    await withDeferred("replacement", async (queue, old, _abort, fixture) => {
      const retired = await queue.listClaims();
      old.drain.dispose();
      const next = await deferNext(fixture, undefined, 60_000);
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
    });
  });
});

it("does not report a retry after the claim was reclaimed", async () => {
  await withDrainFixture(
    async ({ queue, enqueue, createDrain, lifecycles }) => {
      await enqueue("evt-head", "question", "dm");
      const logs: string[] = [];
      const drain = createDrain({
        onLog: (message) => logs.push(message),
        dispatchClaimedEvent: () => ({ kind: "deferred" }),
      });
      await drain.drainOnce();
      await vi.waitFor(() => expect(lifecycles[0]).toBeDefined());
      expect(await queue.recoverStaleClaims({ staleMs: 0, now: 10_001 })).toBe(1);
      const fail = expectDefined(lifecycles[0]?.onFailed, "onFailed callback");
      await fail(new Error("dispatch failure"));
      expect(await queue.listFailed?.()).toHaveLength(0);
      expect(await queue.listPending()).toHaveLength(1);
      expect(logs.some((message) => message.includes("; keeping for retry:"))).toBe(false);
    },
    () => 10_000,
  );
});

it("retains the retried failed head and drains its follower without replay", async () => {
  await withDrainFixture(
    async ({ queue, enqueue, createDrain, byId: lifecycles, stateDir }) => {
      await enqueue("evt-head", "question", "dm", 1);
      await enqueue("evt-follower", "next", "dm", 2);
      const claim = expectDefined(
        await queue.claim("evt-head", { ownerId: "previous-worker" }),
        "previous claim",
      );
      await queue.release(claim, { lastError: "temporary failure", releasedAt: 10 });
      const drain = createDrain({
        deferredLaneOccupancy: "release",
        dispatchClaimedEvent: async () => ({ kind: "deferred" }),
      });
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
      await expectDefined(lifecycles.get("evt-head")?.onFailed, "onFailed callback")(error);
      const expectedFailed = {
        id: "evt-head",
        channelId: "test",
        accountId: "a",
        queueName: JSON.stringify(["test", "a"]),
        laneKey: "dm",
        payload: { text: "question" },
        receivedAt: 1,
        updatedAt: 10_000,
        attempts: 1,
        lastAttemptAt: 10,
        failedAt: 10_000,
        reason: "restart-recovery-tombstone",
        message:
          "reply admission refused | terminal generation | SESSION_RESTART_RECOVERY_TOMBSTONE",
      };
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([expectedFailed]);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect([...lifecycles.keys()]).toEqual(["evt-head", "evt-follower"]));
      await expectDefined(lifecycles.get("evt-follower"), "follower lifecycle").onAdopted();
      expect([await queue.listPending(), await queue.listClaims()]).toEqual([[], []]);
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
        expect(await reopened.listFailed?.({ limit: "all" })).toEqual([expectedFailed]);
      } finally {
        restarted.dispose();
      }
    },
    () => 10_000,
  );
});
it.each([false, true])("handles debounce retry (settlement fails: %s)", async (settlementFails) => {
  if (settlementFails) {
    vi.useFakeTimers();
  }
  let clock = 10_000;
  await withDrainFixture(
    async ({ queue, enqueue, createDrain }) => {
      const id = settlementFails ? "debounced-settlement-failure" : "debounced-retry";
      await enqueue(id, "retry me", "shared", clock);
      if (settlementFails) {
        queue.release = async () => {
          throw new Error("persistent release failure");
        };
      }
      const log = vi.fn();
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
              if (settlementFails || attempt === 1) {
                throw sessionError;
              }
              await lifecycle.onAdopted();
            },
          }),
        onError: settlementFails ? () => undefined : (error) => reportedErrors.push(error),
      });
      const drain = createDrain({
        ...(settlementFails
          ? { adoptionStallTimeoutMs: 200_000, onLog: log }
          : {
              adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
              retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
            }),
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await debouncer.enqueue({ lifecycle });
          return { kind: "deferred" };
        },
      });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      if (settlementFails) {
        await vi.advanceTimersByTimeAsync(127_000);
        clock += 127_000;
        await drain.waitForIdle();
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([id]);
        expect(drain.activeLaneKeys().has("shared")).toBe(true);
        clock += 73_000;
        await vi.advanceTimersByTimeAsync(73_000);
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([id]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(drain.activeLaneKeys().has("shared")).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("applying retry policy (handler-timeout)"),
        );
      } else {
        await drain.waitForIdle();
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id, attempts: 1, lastError: sessionError.message },
        ]);
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        clock += 1_000;
        expect(await drain.drainOnce()).toEqual({ started: 1 });
        await drain.waitForIdle();
        await debouncer.drain();
        expect(attempt).toBe(2);
        expect(reportedErrors).toEqual([sessionError]);
        await expectEmpty(queue);
        expect(await queue.enqueue(id, { text: "retry me" })).toMatchObject({
          kind: "completed",
        });
      }
    },
    () => clock,
  );
});
it("tracks a monitor delivery after its webhook pump closes and a queued followup after delivery settles", async () => {
  await withDrainFixture(async ({ queue, stateDir }) => {
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
          pumpSignals.push(expectDefined(getAsyncWorkSignal(), "pump work signal"));
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
      expect([await queue.listPending(), await queue.listClaims()]).toEqual([[], []]);

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
