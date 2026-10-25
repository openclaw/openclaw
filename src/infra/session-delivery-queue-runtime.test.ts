import { describe, expect, it as baseIt, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as recovery from "./session-delivery-queue-recovery.js";
import {
  schedulePendingSessionDeliveries,
  scheduleSessionDelivery,
  startSessionDeliveryRuntime as startRuntime,
} from "./session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery as enqueueClaimed,
  enqueueSessionDelivery as enqueue,
  releaseSessionDeliveryClaim as releaseClaim,
} from "./session-delivery-queue-storage.js";
import * as storage from "./session-delivery-queue-storage.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

const nativeDrain = recovery.drainPendingSessionDelivery;
const loadPending = storage.loadPendingSessionDelivery;
const nativeList = storage.loadPendingSessionDeliveries;

const agentTurn = (messageId = "artifact:ready") => ({
  kind: "agentTurn" as const,
  sessionKey: "agent:main:main",
  message: "generated artifact ready",
  messageId,
});
const systemEvent = (text: string) => ({
  kind: "systemEvent" as const,
  sessionKey: "agent:main:main",
  text,
});
type RuntimeOptions = Partial<
  Omit<Parameters<typeof startRuntime>[0], "queueContext" | "scheduler">
>;
async function expectStopPending(stop: () => Promise<void>) {
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  return { stopping };
}
function runtimeFixture(context: OpenClawStateWorkerContext) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const time = { clock, scheduler, advanceBy: clock.advanceBy };
  const deliver = vi.fn(async () => {});
  const stops: Array<() => Promise<void>> = [];
  const releases: Array<() => void> = [];
  const work: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>) => {
    work.push(promise);
    return promise;
  };
  const pending = (id: string) => loadPending(id, context);
  const all = () => nativeList(context);
  const pendingClaim = async (id: string) => {
    const entry = await pending(id);
    if (entry?.availableAt === undefined) {
      throw new Error("Expected a durable claim deadline");
    }
    return { ...entry, availableAt: entry.availableAt };
  };
  const defaults = { deliver, log: logger, queueContext: context, scheduler };
  const delivered = async (mock = deliver, count = 1) => {
    expect(mock).toHaveBeenCalledTimes(count);
    expect(await all()).toStrictEqual([]);
  };
  return {
    context,
    logger,
    time,
    deliver,
    pending,
    all,
    pendingClaim,
    delivered,
    track,
    start(params: RuntimeOptions = {}) {
      const stop = startRuntime({ ...defaults, ...params });
      stops.push(stop);
      return stop;
    },
    async close() {
      const stopping = stops.map((stop) => stop());
      releases.forEach((release) => release());
      await Promise.all([...stopping, ...work]);
    },
    hold() {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      releases.push(() => release.resolve());
      const held = vi.fn(() => {
        entered.resolve();
        return release.promise;
      });
      return { entered, release, deliver: held };
    },
    gate<T>(fallback: T) {
      const gate = createDeferredCore<T>();
      releases.push(() => gate.resolve(fallback));
      return gate;
    },
    wake: () => track(Promise.resolve(clock.advanceBy(0))),
    enqueue: (payload = agentTurn()) => enqueue(payload, context),
    enqueueEvent: (text: string) => enqueue(systemEvent(text), context),
    schedule: (id: string) => scheduleSessionDelivery(id, context),
    release: (id: string) => releaseClaim(id, context),
    async claim(leaseMs = 60_000) {
      const { id } = await enqueueClaimed(
        { ...agentTurn(), idempotencyKey: "artifact:ready" },
        leaseMs,
        context,
      );
      return { id, claimed: await pendingClaim(id) };
    },
    async finish(done: () => Promise<void>, mock = deliver, count = 1, delay = 0) {
      await time.advanceBy(delay);
      await done();
      await delivered(mock, count);
    },
    async idleFor(delay: number, mock = deliver) {
      await time.advanceBy(delay);
      expect(mock).not.toHaveBeenCalled();
    },
    async retryDrain(params: Parameters<typeof nativeDrain>[0]) {
      const entry = await nativeDrain(params);
      if (entry?.lastAttemptAt === undefined) {
        throw new Error("Expected a persisted retry timestamp before rearming the scheduler");
      }
      clock.setTime(entry.lastAttemptAt);
      return entry;
    },
  };
}
const it = baseIt.extend<{ runtime: ReturnType<typeof runtimeFixture> }>({
  runtime: ({ task: _task }, use) =>
    withSessionDeliveryQueue(async (_stateDir, context) => {
      const fixture = runtimeFixture(context);
      try {
        await use(fixture);
      } finally {
        // Join admitted work before the queue helper closes its database.
        await fixture.close();
        await fixture.time.scheduler.stop();
        vi.restoreAllMocks();
      }
    }),
});

describe("session delivery queue runtime", () => {
  it("drains one scheduled id without requesting the pending inventory", async ({ runtime: r }) => {
    const id = await r.enqueue();
    const unrelatedId = await r.enqueue(agentTurn("unrelated"));
    const listPending = vi.spyOn(storage, "loadPendingSessionDeliveries");
    const onSettled = vi.fn(async () => {});
    const stop = r.start({ onSettled });
    await expect(r.schedule(id)).resolves.toBe(true);
    await r.time.advanceBy(0);
    await stop();
    expect(listPending).not.toHaveBeenCalled();
    expect(r.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), {
      queueContext: r.context,
    });
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "recovered", r.context);
    expect(await r.pending(id)).toBeNull();
    const pending = await r.all();
    expect(pending.map((entry) => entry.id)).toEqual([unrelatedId]);
  });

  it.for(["lookup failure", "drain failure", "unchanged row"] as const)(
    "backs off after a transient %s without losing the durable entry",
    async (mode, { runtime: r }) => {
      const id = await r.enqueue();
      const reloadPending = vi.spyOn(storage, "loadPendingSessionDelivery");
      const drain = vi.spyOn(recovery, "drainPendingSessionDelivery");
      if (mode === "lookup failure") {
        reloadPending.mockRejectedValueOnce(new Error("database busy"));
      } else if (mode === "drain failure") {
        drain.mockRejectedValueOnce(new Error("database scan failed"));
      } else {
        drain.mockImplementationOnce((params) => loadPending(params.id, params.queueContext));
      }
      const stop = r.start();
      await expect(r.schedule(id)).resolves.toBe(true);
      await r.time.advanceBy(0);
      expect(r.logger.error).toHaveBeenCalledTimes(mode === "unchanged row" ? 0 : 1);
      expect(await r.pending(id)).not.toBeNull();
      expect(r.deliver).not.toHaveBeenCalled();
      await r.idleFor(999);
      await r.finish(stop, r.deliver, 1, 1);
    },
  );

  it.for(["steady", "rollback"] as const)(
    "rearms a released claim immediately after a %s clock",
    async (mode, { runtime: r }) => {
      const { id, claimed } = await r.claim();
      const stop = r.start();
      if (mode === "rollback") {
        r.time.clock.setTime(claimed.availableAt);
      }
      await r.schedule(id);
      if (mode === "steady") {
        await r.idleFor(30_000);
      }
      await r.release(id);
      const released = await r.pendingClaim(id);
      if (mode === "rollback") {
        expect(released.availableAt).toBeLessThan(claimed.availableAt);
      }
      r.time.clock.setTime(released.availableAt);
      await r.schedule(id);
      await r.finish(stop);
    },
  );

  it("recomputes future claim timers after a clock jump", async ({ runtime: r }) => {
    const dayMs = 24 * 60 * 60 * 1_000;
    const { id, claimed } = await r.claim(2 * dayMs);
    const stop = r.start();
    r.time.clock.setTime(claimed.availableAt - 2 * dayMs);
    await r.schedule(id);
    r.time.clock.setTime(claimed.availableAt - dayMs);
    await r.schedule(id);
    await r.idleFor(dayMs - 1);
    await r.finish(stop, r.deliver, 1, 1);
  });

  it("drains an eligible entry across a clock rollback", async ({ runtime: r }) => {
    const id = await r.enqueueEvent("ready before rollback");
    const stop = r.start();
    r.time.clock.setTime(10_000);
    await r.schedule(id);
    r.time.clock.setTime(5_000);
    await r.finish(stop);
  });

  it("ignores a stale claim lookup after rollback and release", async ({ runtime: r }) => {
    const { id } = await enqueueClaimed(systemEvent("released claim"), 60_000, r.context);
    const claimed = await r.pendingClaim(id);
    const staleRead = r.gate(claimed);
    vi.spyOn(storage, "loadPendingSessionDelivery").mockImplementationOnce(() => staleRead.promise);
    const stop = r.start();
    const staleScheduling = r.track(r.schedule(id));
    await r.release(id);
    const released = await r.pendingClaim(id);
    r.time.clock.setTime(released.availableAt + 5_000);
    await r.schedule(id);
    r.time.clock.setTime(released.availableAt);
    staleRead.resolve(claimed);
    await staleScheduling;
    await r.finish(stop);
  });

  it("coalesces duplicate schedules and joins the active drain on stop", async ({ runtime: r }) => {
    const id = await r.enqueue();
    const { release: delivery, entered, deliver } = r.hold();
    const stop = r.start({ deliver });
    const sibling = vi.fn();
    r.time.scheduler.schedule({ id: "unrelated-owner", delayMs: 1, run: sibling });
    await r.schedule(id);
    void r.wake();
    await entered.promise;
    expect(deliver).toHaveBeenCalledTimes(1);
    await r.schedule(id);
    void r.wake();
    expect(deliver).toHaveBeenCalledTimes(1);
    const { stopping } = await expectStopPending(stop);
    await expect(r.schedule(id)).resolves.toBe(false);
    await r.time.advanceBy(1);
    expect(sibling).toHaveBeenCalledOnce();
    delivery.resolve();
    await stopping;
    expect(await r.all()).toStrictEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.for([false, true])(
    "retries a failed agent turn after durable backoff (final lookup failure: %s)",
    async (lookupFailure, { runtime: r }) => {
      const id = await r.enqueue();
      const deliver = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("session locked"))
        .mockResolvedValueOnce();
      vi.spyOn(recovery, "drainPendingSessionDelivery").mockImplementationOnce(async (params) => {
        const pending = await r.retryDrain(params);
        if (lookupFailure) {
          throw new Error("database busy");
        }
        return pending;
      });
      const stop = r.start({ deliver });
      await r.schedule(id);
      await r.time.advanceBy(0);
      expect(r.logger.error).toHaveBeenCalledTimes(lookupFailure ? 1 : 0);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await r.all()).toEqual([
        expect.objectContaining({ id, retryCount: 1, lastError: "session locked" }),
      ]);
      const attemptedAt = r.time.scheduler.now();
      if (lookupFailure) {
        await r.time.advanceBy(1_000);
      }
      await r.time.advanceBy(lookupFailure ? 3_999 : 4_999);
      expect(r.time.scheduler.now() - attemptedAt).toBe(4_999);
      expect(deliver).toHaveBeenCalledTimes(1);
      await r.finish(stop, deliver, 2, 1);
    },
  );

  it("reschedules pending entries after the runtime owner restarts", async ({ runtime: r }) => {
    const oldDeliver = r.deliver;
    const id = await r.enqueue(agentTurn("music:task-1:agent-loop"));
    const stopOldRuntime = r.start();
    await r.schedule(id);
    await stopOldRuntime();
    await expect(r.schedule(id)).resolves.toBe(false);
    await r.time.advanceBy(0);
    expect(oldDeliver).not.toHaveBeenCalled();
    expect(await r.all()).toEqual([expect.objectContaining({ id })]);
    const resumedDeliver = vi.fn(async () => {});
    const stopResumedRuntime = r.start({ deliver: resumedDeliver });
    await stopOldRuntime();
    await schedulePendingSessionDeliveries();
    await r.time.advanceBy(0);
    await stopResumedRuntime();
    expect(oldDeliver).not.toHaveBeenCalled();
    await r.delivered(resumedDeliver);
  });

  it("joins only retired drains after runtime replacement", async ({ runtime: r }) => {
    const { release: oldDelivery, entered: oldEntered, deliver: oldDeliver } = r.hold();
    const { entered: newEntered, deliver: newDeliver } = r.hold();
    const oldId = await r.enqueue(agentTurn("old-owner-delivery"));
    const newId = await r.enqueue(agentTurn("new-owner-delivery"));
    const stopOld = r.start({ deliver: oldDeliver });
    await r.schedule(oldId);
    void r.wake();
    await oldEntered.promise;
    expect(oldDeliver).toHaveBeenCalledOnce();
    r.start({ deliver: newDeliver });
    await r.schedule(newId);
    void r.wake();
    await newEntered.promise;
    expect(newDeliver).toHaveBeenCalledOnce();
    const { stopping } = await expectStopPending(stopOld);
    oldDelivery.resolve();
    await stopping;
    expect(await r.pending(oldId)).toBeNull();
    expect(await r.pending(newId)).not.toBeNull();
    await expect(r.schedule(newId)).resolves.toBe(true);
  });

  it.for([
    { mode: "lookup", failure: false },
    { mode: "lookup", failure: true },
    { mode: "scan", failure: false },
    { mode: "scan", failure: true },
  ])(
    "joins a retired owner's delayed $mode (failure: $failure)",
    async ({ mode, failure }, { runtime: r }) => {
      const id = await r.enqueueEvent("delivery awaiting queue lookup");
      const oldRead = r.gate(undefined);
      const newRead = r.gate(undefined);
      const waitForOldRead = async () => {
        await oldRead.promise;
        if (failure) {
          throw new Error("delayed database read failure");
        }
      };
      const reloadPending = vi.spyOn(storage, "loadPendingSessionDelivery");
      reloadPending.mockImplementation(async (entryId) => {
        await waitForOldRead();
        return r.pending(entryId);
      });
      const listPending = vi.spyOn(storage, "loadPendingSessionDeliveries");
      listPending.mockImplementation(async () => {
        await waitForOldRead();
        return r.all();
      });
      const stopOld = r.start();
      const scheduling =
        mode === "lookup" ? r.track(r.schedule(id)) : r.track(schedulePendingSessionDeliveries());
      const { stopping } = await expectStopPending(stopOld);
      await expect(r.schedule(id)).resolves.toBe(false);
      reloadPending.mockRestore();
      listPending.mockImplementation(async () => {
        await newRead.promise;
        return r.all();
      });
      const stopNew = r.start();
      const newScheduling = r.track(schedulePendingSessionDeliveries());
      oldRead.resolve(undefined);
      await scheduling;
      await stopping;
      expect(r.logger.error).toHaveBeenCalledTimes(failure ? 1 : 0);
      await r.time.clock.advanceBy(1_000);
      expect(r.deliver).not.toHaveBeenCalled();
      expect(await r.pending(id)).not.toBeNull();
      newRead.resolve(undefined);
      await newScheduling;
      await r.finish(stopNew);
    },
  );

  it("keeps the earliest retry across repeated scan failures", async ({ runtime: r }) => {
    await r.enqueue(agentTurn("music:task-scan:agent-loop"));
    vi.spyOn(storage, "loadPendingSessionDeliveries")
      .mockRejectedValueOnce(new Error("database busy"))
      .mockRejectedValueOnce(new Error("database still busy"))
      .mockImplementation(() => r.all());
    const stop = r.start();
    await schedulePendingSessionDeliveries();
    expect(r.logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to scan"));
    expect(r.deliver).not.toHaveBeenCalled();
    await r.time.advanceBy(500);
    await schedulePendingSessionDeliveries();
    await r.idleFor(499);
    await r.time.advanceBy(1);
    await r.finish(stop);
  });
});
