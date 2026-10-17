import { describe, expect, it as baseIt, test, vi, type Mock } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { drainPendingSessionDelivery } from "./session-delivery-queue-recovery.js";
import {
  schedulePendingSessionDeliveries,
  scheduleSessionDelivery,
  startSessionDeliveryRuntime,
} from "./session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
  releaseSessionDeliveryClaim,
} from "./session-delivery-queue-storage.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function agentTurn(messageId = "artifact:ready") {
  return {
    kind: "agentTurn" as const,
    sessionKey: "agent:main:main",
    message: "generated artifact ready",
    messageId,
  };
}
const systemEvent = (text: string) => ({
  kind: "systemEvent" as const,
  sessionKey: "agent:main:main",
  text,
});
async function claim(queueContext: OpenClawStateWorkerContext, leaseMs = 60_000) {
  const { id } = await enqueueClaimedSessionDelivery(
    { ...agentTurn(), idempotencyKey: "artifact:ready" },
    leaseMs,
    queueContext,
  );
  return { id, claimed: await pendingClaim(id, queueContext) };
}
async function pendingClaim(id: string, queueContext: OpenClawStateWorkerContext) {
  const entry = await loadPendingSessionDelivery(id, queueContext);
  if (entry?.availableAt === undefined) {
    throw new Error("Expected a durable claim deadline");
  }
  return { ...entry, availableAt: entry.availableAt };
}

async function expectDelivered(
  deliver: Mock<() => Promise<void>>,
  queueContext: OpenClawStateWorkerContext,
  count = 1,
) {
  expect(deliver).toHaveBeenCalledTimes(count);
  expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
}
function heldDelivery() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const deliver = vi.fn(() => {
    entered.resolve();
    return release.promise;
  });
  return { entered, release, deliver };
}
async function expectStopPending(stop: () => Promise<void>) {
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  return { stopping };
}

type StartRuntimeForTest = (
  params?: Partial<
    Omit<Parameters<typeof startSessionDeliveryRuntime>[0], "queueContext" | "scheduler">
  >,
) => ReturnType<typeof startSessionDeliveryRuntime>;

function runtimeFixture(
  context: OpenClawStateWorkerContext,
  time: ReturnType<typeof createRuntimeClock>,
) {
  const deliver = vi.fn(async () => {});
  let stop: ReturnType<typeof startSessionDeliveryRuntime> | undefined;
  return {
    context,
    time,
    deliver,
    start(params: Parameters<StartRuntimeForTest>[0] = {}) {
      return (stop = startSessionDeliveryRuntime({
        deliver,
        log: logger,
        ...params,
        queueContext: context,
        scheduler: time.scheduler,
      }));
    },
    close: () => stop?.(),
    enqueue: (payload = agentTurn()) => enqueueSessionDelivery(payload, context),
    enqueueEvent: (text: string) => enqueueSessionDelivery(systemEvent(text), context),
    pending: (id: string) => loadPendingSessionDelivery(id, context),
    all: () => loadPendingSessionDeliveries(context),
    schedule: (id: string) => scheduleSessionDelivery(id, context),
    release: (id: string) => releaseSessionDeliveryClaim(id, context),
    claim: (leaseMs = 60_000) => claim(context, leaseMs),
    pendingClaim: (id: string) => pendingClaim(id, context),
    finish: (done: ReturnType<typeof startSessionDeliveryRuntime>, mock = deliver) =>
      finish(done, context, time, mock),
  };
}
async function withRuntime(run: (runtime: ReturnType<typeof runtimeFixture>) => Promise<void>) {
  await withTestDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const fixture = runtimeFixture(captureOpenClawStateWorkerContext(), createRuntimeClock());
      try {
        await run(fixture);
      } finally {
        // Retire and join the owner before restoring its environment or removing its queue.
        try {
          await fixture.close();
          await fixture.time.scheduler.stop();
          await closeOpenClawStateDatabaseByPathAsync(fixture.context.admission.databasePath);
        } finally {
          for (const mock of Object.values(logger)) {
            mock.mockClear();
          }
        }
      }
    });
  });
}
const it = baseIt.extend<{ runtime: ReturnType<typeof runtimeFixture> }>({
  runtime: async ({ task: _task }, use) => {
    await withRuntime(use);
  },
});
async function finish(
  stop: ReturnType<typeof startSessionDeliveryRuntime>,
  queueContext: OpenClawStateWorkerContext,
  time: ReturnType<typeof createRuntimeClock>,
  deliver: Mock<() => Promise<void>>,
) {
  await time.advanceBy(0);
  await stop();
  await expectDelivered(deliver, queueContext);
}

function createRuntimeClock() {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  return {
    clock,
    scheduler,
    advanceBy: clock.advanceBy,
  };
}

async function drainAtPersistedAttemptTime(
  params: Parameters<typeof drainPendingSessionDelivery>[0],
  time: ReturnType<typeof createRuntimeClock>,
) {
  const pending = await drainPendingSessionDelivery(params);
  if (pending?.lastAttemptAt === undefined) {
    throw new Error("Expected a persisted retry timestamp before rearming the scheduler");
  }
  time.clock.setTime(pending.lastAttemptAt);
  return pending;
}

describe("session delivery queue runtime", () => {
  it("drains one scheduled id without requesting the pending inventory", async ({ runtime: r }) => {
    const deliver = r.deliver;
    const id = await r.enqueue();
    const unrelatedIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      unrelatedIds.push(await r.enqueue(agentTurn(`unrelated:${index}`)));
    }
    const reloadPending = vi.fn(loadPendingSessionDelivery);
    const listPending = vi.fn(loadPendingSessionDeliveries);
    const drain = vi.fn(drainPendingSessionDelivery);
    const onSettled = vi.fn(async () => {});
    const stop = r.start({ reloadPending, listPending, drain, onSettled });

    await expect(r.schedule(id)).resolves.toBe(true);
    expect(reloadPending).toHaveBeenCalledExactlyOnceWith(id, r.context);
    await r.time.advanceBy(0);
    await stop();

    expect(listPending).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id, queueContext: r.context }),
    );
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), {
      queueContext: r.context,
    });
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "recovered", r.context);
    expect(await r.pending(id)).toBeNull();
    const pending = await r.all();
    expect(pending.map((entry) => entry.id).toSorted()).toEqual(unrelatedIds.toSorted());
  });

  test.each(["lookup failure", "drain failure", "unchanged row"] as const)(
    "backs off after a transient %s without losing the durable entry",
    async (mode) => {
      await withRuntime(async (r) => {
        const deliver = r.deliver;
        const id = await r.enqueue();
        const reloadPending = vi.fn(loadPendingSessionDelivery);
        const drain = vi.fn(drainPendingSessionDelivery);
        if (mode === "lookup failure") {
          reloadPending.mockRejectedValueOnce(new Error("database busy"));
        } else if (mode === "drain failure") {
          drain.mockRejectedValueOnce(new Error("database scan failed"));
        } else {
          drain.mockImplementationOnce((params) =>
            loadPendingSessionDelivery(params.id, params.queueContext),
          );
        }
        const stop = r.start({ reloadPending, drain });

        await expect(r.schedule(id)).resolves.toBe(true);
        await r.time.advanceBy(0);
        if (mode === "lookup failure") {
          expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to load"));
        } else if (mode === "drain failure") {
          await expect(drain.mock.results[0]?.value).rejects.toThrow("database scan failed");
          expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("runtime drain failed"),
          );
        } else {
          await expect(drain.mock.results[0]?.value).resolves.toMatchObject({ id, retryCount: 0 });
        }
        expect(deliver).not.toHaveBeenCalled();
        await r.time.advanceBy(999);
        expect(deliver).not.toHaveBeenCalled();
        await r.time.advanceBy(1);
        await stop();
        await expectDelivered(deliver, r.context);
      });
    },
  );

  test.each(["steady", "rollback", "forward jump"] as const)(
    "rearms a released claim immediately after a %s clock",
    async (mode) => {
      await withRuntime(async (r) => {
        const { id, claimed } = await r.claim();
        const entered = createDeferredCore();
        const deliver = vi.fn(async () => {
          entered.resolve();
        });
        const stop = r.start({ deliver });
        if (mode === "rollback") {
          r.time.clock.setTime(claimed.availableAt);
        }
        await r.schedule(id);
        if (mode === "steady") {
          await r.time.advanceBy(30_000);
          expect(deliver).not.toHaveBeenCalled();
        } else if (mode === "forward jump") {
          r.time.clock.setTime(r.time.scheduler.now() + 24 * 60 * 60 * 1_000);
        }
        await r.release(id);
        const released = await r.pendingClaim(id);
        if (mode === "rollback") {
          expect(released.availableAt).toBeLessThan(claimed.availableAt);
        }
        if (mode !== "forward jump") {
          r.time.clock.setTime(released.availableAt);
        }
        await r.schedule(id);
        if (mode === "forward jump") {
          expect(r.time.scheduler.nextWakeAtMs).toBeLessThanOrEqual(r.time.scheduler.now());
          expect(r.time.clock.wakes.at(-1)?.delayMs).toBe(0);
        }
        await r.time.advanceBy(0);
        await entered.promise;
        await stop();
        await expectDelivered(deliver, r.context);
      });
    },
  );

  it("recomputes a future claim timer after the wall clock jumps forward", async ({
    runtime: r,
  }) => {
    const deliver = r.deliver;
    const dayMs = 24 * 60 * 60 * 1_000;
    const { id, claimed } = await r.claim(2 * dayMs);
    const stop = r.start();
    r.time.clock.setTime(claimed.availableAt - 2 * dayMs);
    await r.schedule(id);
    r.time.clock.setTime(claimed.availableAt - dayMs);
    await r.schedule(id);
    expect(r.time.clock.wakes.at(-1)?.delayMs).toBe(dayMs);

    await r.time.advanceBy(dayMs - 1);
    expect(deliver).not.toHaveBeenCalled();
    await r.time.advanceBy(1);
    await stop();
    await expectDelivered(deliver, r.context);
  });

  it("drains an eligible entry across a clock rollback", async ({ runtime: r }) => {
    const deliver = r.deliver;
    const id = await r.enqueueEvent("ready before rollback");
    const stop = r.start();

    r.time.clock.setTime(10_000);
    await r.schedule(id);
    r.time.clock.setTime(5_000);
    await r.finish(stop, deliver);
  });

  it("ignores a stale claim lookup after rollback and release", async ({ runtime: r }) => {
    const deliver = r.deliver;
    const { id } = await enqueueClaimedSessionDelivery(
      systemEvent("released claim"),
      60_000,
      r.context,
    );
    const claimed = await r.pendingClaim(id);
    const staleRead = createDeferredCore<typeof claimed>();
    const reloadPending = vi
      .fn(loadPendingSessionDelivery)
      .mockImplementationOnce(() => staleRead.promise);
    const stop = r.start({ reloadPending });
    const staleScheduling = r.schedule(id);
    try {
      await r.release(id);
      const released = await r.pendingClaim(id);
      r.time.clock.setTime(released.availableAt + 5_000);
      await r.schedule(id);
      r.time.clock.setTime(released.availableAt);
      staleRead.resolve(claimed);
      await staleScheduling;
      await r.finish(stop, deliver);
    } finally {
      staleRead.resolve(claimed);
      await staleScheduling;
    }
  });

  it("coalesces duplicate schedules and joins the active drain on stop", async ({ runtime: r }) => {
    const id = await r.enqueue();
    const { release: delivery, entered, deliver } = heldDelivery();
    let stopping: Promise<void> | undefined;
    const wakes: Promise<void>[] = [];
    const stop = r.start({ deliver });
    const sibling = vi.fn();
    r.time.scheduler.schedule({ id: "unrelated-owner", delayMs: 1, run: sibling });

    try {
      await r.schedule(id);
      wakes.push(Promise.resolve(r.time.clock.advanceBy(0)));
      await entered.promise;
      expect(deliver).toHaveBeenCalledTimes(1);

      await r.schedule(id);
      wakes.push(Promise.resolve(r.time.clock.advanceBy(0)));
      expect(deliver).toHaveBeenCalledTimes(1);

      ({ stopping } = await expectStopPending(stop));
      await expect(r.schedule(id)).resolves.toBe(false);

      await r.time.advanceBy(1);
      expect(sibling).toHaveBeenCalledOnce();
      delivery.resolve();
      await stopping;
      expect(await r.all()).toStrictEqual([]);
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      const cleanup = stop();
      delivery.resolve();
      await cleanup;
      await stopping;
      await Promise.all(wakes);
    }
  });

  test.each([false, true])(
    "retries a failed agent turn after durable backoff (final lookup failure: %s)",
    async (lookupFailure) => {
      await withRuntime(async (r) => {
        const id = await r.enqueue();
        const deliver = vi
          .fn<() => Promise<void>>()
          .mockRejectedValueOnce(new Error("session locked"))
          .mockResolvedValueOnce();
        const drain = vi.fn(drainPendingSessionDelivery).mockImplementationOnce(async (params) => {
          const pending = await drainAtPersistedAttemptTime(params, r.time);
          if (lookupFailure) {
            throw new Error("database busy");
          }
          return pending;
        });
        const stop = r.start({ deliver, drain });

        await r.schedule(id);
        await r.time.advanceBy(0);
        if (lookupFailure) {
          await expect(drain.mock.results[0]?.value).rejects.toThrow("database busy");
          expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("runtime drain failed"),
          );
        } else {
          await expect(drain.mock.results[0]?.value).resolves.toMatchObject({ id, retryCount: 1 });
        }
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(await r.all()).toEqual([
          expect.objectContaining({ id, retryCount: 1, lastError: "session locked" }),
        ]);
        const attemptedAt = r.time.scheduler.now();
        if (lookupFailure) {
          await r.time.advanceBy(1_000);
          await expect(drain.mock.results[1]?.value).resolves.toMatchObject({ id, retryCount: 1 });
        }
        await r.time.advanceBy(lookupFailure ? 3_999 : 4_999);
        expect(r.time.scheduler.now() - attemptedAt).toBe(4_999);
        expect(deliver).toHaveBeenCalledTimes(1);
        await r.time.advanceBy(1);
        await stop();
        await expectDelivered(deliver, r.context, 2);
      });
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
    await expectDelivered(resumedDeliver, r.context);
  });

  it("joins only the retired owner's drains after a runtime replacement", async ({
    runtime: r,
  }) => {
    const { release: oldDelivery, entered: oldEntered, deliver: oldDeliver } = heldDelivery();
    const { release: newDelivery, entered: newEntered, deliver: newDeliver } = heldDelivery();
    const oldId = await r.enqueue(agentTurn("old-owner-delivery"));
    const newId = await r.enqueue(agentTurn("new-owner-delivery"));
    const stopOld = r.start({ deliver: oldDeliver });
    let stopNew: ReturnType<typeof startSessionDeliveryRuntime> | undefined;
    const wakes: Promise<void>[] = [];
    try {
      await r.schedule(oldId);
      wakes.push(Promise.resolve(r.time.clock.advanceBy(0)));
      await oldEntered.promise;
      expect(oldDeliver).toHaveBeenCalledOnce();
      stopNew = r.start({ deliver: newDeliver });
      await r.schedule(newId);
      wakes.push(Promise.resolve(r.time.clock.advanceBy(0)));
      await newEntered.promise;
      expect(newDeliver).toHaveBeenCalledOnce();

      const { stopping } = await expectStopPending(stopOld);
      oldDelivery.resolve();
      await stopping;
      expect(await r.pending(oldId)).toBeNull();
      expect(await r.pending(newId)).not.toBeNull();
      await expect(r.schedule(newId)).resolves.toBe(true);
    } finally {
      oldDelivery.resolve();
      newDelivery.resolve();
      await Promise.all([stopOld(), stopNew?.(), ...wakes]);
    }
  });

  test.each([
    { mode: "lookup", failure: false },
    { mode: "lookup", failure: true },
    { mode: "scan", failure: false },
    { mode: "scan", failure: true },
  ])("joins a retired owner's delayed $mode (failure: $failure)", async ({ mode, failure }) => {
    await withRuntime(async (r) => {
      const deliver = r.deliver;
      const id = await r.enqueueEvent("delivery awaiting queue lookup");
      const oldRead = createDeferredCore();
      const newRead = createDeferredCore();
      const waitForOldRead = async () => {
        await oldRead.promise;
        if (failure) {
          throw new Error("delayed database read failure");
        }
      };
      const stopOld = r.start({
        reloadPending: async (entryId) => {
          await waitForOldRead();
          return r.pending(entryId);
        },
        listPending: async () => {
          await waitForOldRead();
          return r.all();
        },
      });
      const scheduling = mode === "lookup" ? r.schedule(id) : schedulePendingSessionDeliveries();
      let stopNew: ReturnType<typeof startSessionDeliveryRuntime> | undefined;
      let newScheduling: Promise<void> | undefined;
      try {
        const { stopping } = await expectStopPending(stopOld);
        await expect(r.schedule(id)).resolves.toBe(false);

        stopNew = r.start({
          listPending: async () => {
            await newRead.promise;
            return r.all();
          },
        });
        newScheduling = schedulePendingSessionDeliveries();
        oldRead.resolve();
        await scheduling;
        await stopping;
        expect(logger.error).toHaveBeenCalledTimes(failure ? 1 : 0);
        await r.time.clock.advanceBy(1_000);
        expect(deliver).not.toHaveBeenCalled();
        expect(await r.pending(id)).not.toBeNull();

        newRead.resolve();
        await newScheduling;
        await r.finish(stopNew, deliver);
      } finally {
        oldRead.resolve();
        newRead.resolve();
        await Promise.all([scheduling, newScheduling, stopOld(), stopNew?.()]);
      }
    });
  });

  it("keeps the earliest retry across repeated scan failures", async ({ runtime: r }) => {
    const deliver = r.deliver;
    await r.enqueue(agentTurn("music:task-scan:agent-loop"));
    const listPending = vi
      .fn<typeof loadPendingSessionDeliveries>()
      .mockRejectedValueOnce(new Error("database busy"))
      .mockRejectedValueOnce(new Error("database still busy"))
      .mockImplementation(() => r.all());
    const stop = r.start({ listPending });

    await schedulePendingSessionDeliveries();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to scan"));
    expect(deliver).not.toHaveBeenCalled();

    await r.time.advanceBy(500);
    await schedulePendingSessionDeliveries();
    await r.time.advanceBy(499);
    expect(deliver).not.toHaveBeenCalled();
    await r.time.advanceBy(1);
    await expect(listPending.mock.results[2]?.value).resolves.toHaveLength(1);
    await r.finish(stop, deliver);
  });
});
