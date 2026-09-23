// Covers same-process scheduling for durable session delivery retries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
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

type StartRuntimeForTest = (
  params: Omit<Parameters<typeof startSessionDeliveryRuntime>[0], "queueContext">,
) => ReturnType<typeof startSessionDeliveryRuntime>;

async function withRuntime(
  run: (start: StartRuntimeForTest, queueContext: OpenClawStateWorkerContext) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-session-delivery-runtime-" }, async (tempDir) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      const queueContext = captureOpenClawStateWorkerContext();
      let stop: ReturnType<typeof startSessionDeliveryRuntime> | undefined;
      try {
        await run(
          (params) => (stop = startSessionDeliveryRuntime({ ...params, queueContext })),
          queueContext,
        );
      } finally {
        // Retire and join the owner before restoring its environment or removing its queue.
        await stop?.();
        await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
      }
    });
  });
}

async function drainAtPersistedAttemptTime(
  params: Parameters<typeof drainPendingSessionDelivery>[0],
) {
  const pending = await drainPendingSessionDelivery(params);
  if (pending?.lastAttemptAt === undefined) {
    throw new Error("Expected a persisted retry timestamp before rearming the scheduler");
  }
  vi.setSystemTime(pending.lastAttemptAt);
  return pending;
}

afterEach(() => {
  vi.useRealTimers();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("session delivery queue runtime", () => {
  it("drains a newly scheduled durable entry", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-1:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const onSettled = vi.fn(async () => {});
      const stop = startRuntime({ deliver, log: logger, onSettled });

      await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await stop();

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        "recovered",
        queueContext,
      );
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("drains one scheduled id without requesting the pending inventory", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "target delivery",
          messageId: "target:agent-loop",
        },
        queueContext,
      );
      const unrelatedIds: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        unrelatedIds.push(
          await enqueueSessionDelivery(
            {
              kind: "agentTurn",
              sessionKey: "agent:main:main",
              message: `unrelated delivery ${index}`,
              messageId: `unrelated:${index}:agent-loop`,
            },
            queueContext,
          ),
        );
      }
      const deliver = vi.fn(async () => {});
      const reloadPending = vi.fn(loadPendingSessionDelivery);
      const listPending = vi.fn(loadPendingSessionDeliveries);
      const drain = vi.fn(drainPendingSessionDelivery);
      const stop = startRuntime({ deliver, reloadPending, listPending, drain, log: logger });

      await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(true);
      expect(reloadPending).toHaveBeenCalledExactlyOnceWith(id, queueContext);
      await vi.advanceTimersByTimeAsync(0);
      await stop();

      expect(listPending).not.toHaveBeenCalled();
      expect(drain).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id, queueContext }));
      expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id }), {
        queueContext,
      });
      expect(await loadPendingSessionDelivery(id, queueContext)).toBeNull();
      const pending = await loadPendingSessionDeliveries(queueContext);
      expect(pending.map((entry) => entry.id).toSorted()).toEqual(unrelatedIds.toSorted());
    });
  });

  it("retries a transient initial queue lookup failure", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-initial-load:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const reloadPending = vi
        .fn<typeof loadPendingSessionDelivery>()
        .mockRejectedValueOnce(new Error("database busy"))
        .mockImplementation((entryId) => loadPendingSessionDelivery(entryId, queueContext));
      const stop = startRuntime({ deliver, log: logger, reloadPending });

      await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(true);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to load"));
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stop();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("holds a claimed entry until release then rearms it immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    await withRuntime(async (startRuntime, queueContext) => {
      const { id } = await enqueueClaimedSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-lease:agent-loop",
          idempotencyKey: "image:task-lease:agent-loop",
        },
        60_000,
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const stop = startRuntime({ deliver, log: logger });

      await scheduleSessionDelivery(id, queueContext);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(deliver).not.toHaveBeenCalled();

      await releaseSessionDeliveryClaim(id, queueContext);
      const released = await loadPendingSessionDelivery(id, queueContext);
      if (released?.availableAt === undefined) {
        throw new Error("Expected the worker to persist the released claim time");
      }
      vi.setSystemTime(released.availableAt);
      await scheduleSessionDelivery(id, queueContext);
      await vi.advanceTimersByTimeAsync(0);
      await stop();

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("recomputes a future claim timer after the wall clock jumps forward", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-15T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1_000;
    vi.setSystemTime(initialTime);
    await withRuntime(async (startRuntime, queueContext) => {
      const { id } = await enqueueClaimedSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-future-clock-jump:agent-loop",
          idempotencyKey: "image:task-future-clock-jump:agent-loop",
        },
        2 * dayMs,
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const stop = startRuntime({ deliver, log: logger });

      await scheduleSessionDelivery(id, queueContext);
      vi.setSystemTime(new Date(initialTime.getTime() + dayMs));
      await scheduleSessionDelivery(id, queueContext);

      await vi.advanceTimersByTimeAsync(dayMs - 1);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stop();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("preempts a released claim after the wall clock jumps past its lease", async () => {
    const initialTime = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    try {
      await withRuntime(async (startRuntime, queueContext) => {
        const { id } = await enqueueClaimedSessionDelivery(
          {
            kind: "agentTurn",
            sessionKey: "agent:main:main",
            message: "generated image ready",
            messageId: "image:task-expired-clock-jump:agent-loop",
            idempotencyKey: "image:task-expired-clock-jump:agent-loop",
          },
          60_000,
          queueContext,
        );
        const entered = createDeferredCore();
        const deliver = vi.fn(async () => {
          entered.resolve();
        });
        const stop = startRuntime({ deliver, log: logger });

        await scheduleSessionDelivery(id, queueContext);
        wallClock.mockReturnValue(initialTime + 24 * 60 * 60 * 1_000);
        await releaseSessionDeliveryClaim(id, queueContext);
        await scheduleSessionDelivery(id, queueContext);

        await entered.promise;
        await stop();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
      });
    } finally {
      wallClock.mockRestore();
    }
  });

  it("coalesces duplicate schedules and joins the active drain on stop", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-in-flight:agent-loop",
        },
        queueContext,
      );
      const delivery = createDeferredCore();
      const entered = createDeferredCore();
      const deliver = vi.fn(() => {
        entered.resolve();
        return delivery.promise;
      });
      let stopping: Promise<void> | undefined;
      const stop = startRuntime({ deliver, log: logger });

      try {
        await scheduleSessionDelivery(id, queueContext);
        vi.advanceTimersByTime(0);
        await entered.promise;
        expect(deliver).toHaveBeenCalledTimes(1);

        await scheduleSessionDelivery(id, queueContext);
        await vi.advanceTimersByTimeAsync(0);
        expect(deliver).toHaveBeenCalledTimes(1);

        let stopped = false;
        stopping = Promise.resolve(stop()).then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(false);

        delivery.resolve();
        await stopping;
        expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        const cleanup = stop();
        delivery.resolve();
        await cleanup;
        await stopping;
      }
    });
  });

  it("retries a failed agent turn after durable backoff", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated video ready",
          messageId: "video:task-1:agent-loop",
        },
        queueContext,
      );
      const deliver = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("session locked"))
        .mockResolvedValueOnce();
      const drain = vi
        .fn(drainPendingSessionDelivery)
        .mockImplementationOnce(drainAtPersistedAttemptTime);
      const stop = startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id, queueContext);
      await vi.advanceTimersByTimeAsync(0);
      await expect(drain.mock.results[0]?.value).resolves.toMatchObject({ id, retryCount: 1 });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({ id, retryCount: 1, lastError: "session locked" }),
      ]);

      const attemptedAt = Date.now();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(Date.now() - attemptedAt).toBe(4_999);
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await stop();
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("rearms a pending entry after a transient final-state lookup failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated video ready",
          messageId: "video:task-reload:agent-loop",
        },
        queueContext,
      );
      const deliver = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("session locked"))
        .mockResolvedValueOnce();
      const drain = vi
        .fn<typeof drainPendingSessionDelivery>()
        .mockImplementationOnce(async (params) => {
          await drainAtPersistedAttemptTime(params);
          throw new Error("database busy");
        })
        .mockImplementation((params) => drainPendingSessionDelivery(params));
      const stop = startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id, queueContext);
      await vi.advanceTimersByTimeAsync(0);
      await expect(drain.mock.results[0]?.value).rejects.toThrow("database busy");
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("runtime drain failed"));

      const attemptedAt = Date.now();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(drain.mock.results[1]?.value).resolves.toMatchObject({ id, retryCount: 1 });
      await vi.advanceTimersByTimeAsync(3_999);
      expect(Date.now() - attemptedAt).toBe(4_999);
      expect(deliver).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await stop();
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("backs off after a drain-level failure leaves retry metadata unchanged", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated video ready",
          messageId: "video:task-drain:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const drain = vi
        .fn<typeof drainPendingSessionDelivery>()
        .mockRejectedValueOnce(new Error("database scan failed"))
        .mockImplementation((params) => drainPendingSessionDelivery(params));
      const stop = startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id, queueContext);
      await vi.advanceTimersByTimeAsync(0);
      await expect(drain.mock.results[0]?.value).rejects.toThrow("database scan failed");
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("runtime drain failed"));
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stop();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("backs off after a no-op drain leaves an immediately due row pending", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated video ready",
          messageId: "video:task-owned-elsewhere:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const drain = vi
        .fn<typeof drainPendingSessionDelivery>()
        .mockImplementationOnce((params) =>
          loadPendingSessionDelivery(params.id, params.queueContext),
        )
        .mockImplementation((params) => drainPendingSessionDelivery(params));
      const stop = startRuntime({ deliver, drain, log: logger });

      await scheduleSessionDelivery(id, queueContext);
      await vi.advanceTimersByTimeAsync(0);
      await expect(drain.mock.results[0]?.value).resolves.toMatchObject({ id, retryCount: 0 });
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stop();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("reschedules pending entries after the runtime owner restarts", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated music ready",
          messageId: "music:task-1:agent-loop",
        },
        queueContext,
      );
      const oldDeliver = vi.fn(async () => {});
      const stopOldRuntime = startRuntime({ deliver: oldDeliver, log: logger });
      await scheduleSessionDelivery(id, queueContext);
      await stopOldRuntime();
      await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(oldDeliver).not.toHaveBeenCalled();
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({ id }),
      ]);
      const resumedDeliver = vi.fn(async () => {});
      const stopResumedRuntime = startRuntime({ deliver: resumedDeliver, log: logger });
      await stopOldRuntime();

      await schedulePendingSessionDeliveries();
      await vi.advanceTimersByTimeAsync(0);
      await stopResumedRuntime();

      expect(oldDeliver).not.toHaveBeenCalled();
      expect(resumedDeliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("joins only the retired owner's drains after a runtime replacement", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const oldDelivery = createDeferredCore();
      const newDelivery = createDeferredCore();
      const oldEntered = createDeferredCore();
      const newEntered = createDeferredCore();
      const oldDeliver = vi.fn(() => {
        oldEntered.resolve();
        return oldDelivery.promise;
      });
      const newDeliver = vi.fn(() => {
        newEntered.resolve();
        return newDelivery.promise;
      });
      const oldId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "old owner delivery",
          messageId: "old-owner-delivery",
        },
        queueContext,
      );
      const newId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "new owner delivery",
          messageId: "new-owner-delivery",
        },
        queueContext,
      );
      const stopOld = startRuntime({ deliver: oldDeliver, log: logger });
      let stopNew: ReturnType<typeof startSessionDeliveryRuntime> | undefined;
      try {
        await scheduleSessionDelivery(oldId, queueContext);
        await vi.advanceTimersByTimeAsync(0);
        await oldEntered.promise;
        expect(oldDeliver).toHaveBeenCalledOnce();
        stopNew = startRuntime({ deliver: newDeliver, log: logger });
        await scheduleSessionDelivery(newId, queueContext);
        await vi.advanceTimersByTimeAsync(0);
        await newEntered.promise;
        expect(newDeliver).toHaveBeenCalledOnce();

        let stopped = false;
        const stopping = Promise.resolve(stopOld()).then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        oldDelivery.resolve();
        await stopping;
        expect(await loadPendingSessionDelivery(oldId, queueContext)).toBeNull();
        expect(await loadPendingSessionDelivery(newId, queueContext)).not.toBeNull();
        await expect(scheduleSessionDelivery(newId, queueContext)).resolves.toBe(true);
      } finally {
        oldDelivery.resolve();
        newDelivery.resolve();
        await Promise.all([stopOld(), stopNew?.()]);
      }
    });
  });

  it.each([
    { mode: "lookup", failure: false },
    { mode: "lookup", failure: true },
    { mode: "scan", failure: false },
    { mode: "scan", failure: true },
  ])("joins a retired owner's delayed $mode (failure: $failure)", async ({ mode, failure }) => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "delivery awaiting queue lookup",
        },
        queueContext,
      );
      const oldRead = createDeferredCore();
      const newRead = createDeferredCore();
      const deliver = vi.fn(async () => {});
      const waitForOldRead = async () => {
        await oldRead.promise;
        if (failure) {
          throw new Error("delayed database read failure");
        }
      };
      const stopOld = startRuntime({
        deliver,
        log: logger,
        reloadPending: async (entryId) => {
          await waitForOldRead();
          return loadPendingSessionDelivery(entryId, queueContext);
        },
        listPending: async () => {
          await waitForOldRead();
          return loadPendingSessionDeliveries(queueContext);
        },
      });
      const scheduling =
        mode === "lookup"
          ? scheduleSessionDelivery(id, queueContext)
          : schedulePendingSessionDeliveries();
      let stopNew: ReturnType<typeof startSessionDeliveryRuntime> | undefined;
      let newScheduling: Promise<void> | undefined;
      try {
        let stopped = false;
        const stopping = stopOld().then(() => {
          stopped = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(false);

        stopNew = startRuntime({
          deliver,
          log: logger,
          listPending: async () => {
            await newRead.promise;
            return loadPendingSessionDeliveries(queueContext);
          },
        });
        newScheduling = schedulePendingSessionDeliveries();
        oldRead.resolve();
        await scheduling;
        await stopping;
        expect(logger.error).toHaveBeenCalledTimes(failure ? 1 : 0);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(deliver).not.toHaveBeenCalled();
        expect(await loadPendingSessionDelivery(id, queueContext)).not.toBeNull();

        newRead.resolve();
        await newScheduling;
        await vi.advanceTimersByTimeAsync(0);
        await stopNew();
        expect(deliver).toHaveBeenCalledOnce();
        expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
      } finally {
        oldRead.resolve();
        newRead.resolve();
        await Promise.all([scheduling, newScheduling, stopOld(), stopNew?.()]);
      }
    });
  });

  it("retries a transient startup pending-entry scan failure", async () => {
    vi.useFakeTimers();
    await withRuntime(async (startRuntime, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated music ready",
          messageId: "music:task-scan:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => {});
      const listPending = vi
        .fn<typeof loadPendingSessionDeliveries>()
        .mockRejectedValueOnce(new Error("database busy"))
        .mockImplementation(() => loadPendingSessionDeliveries(queueContext));
      const stop = startRuntime({ deliver, log: logger, listPending });

      await schedulePendingSessionDeliveries();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to scan"));
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(listPending.mock.results[1]?.value).resolves.toHaveLength(1);
      await vi.runOnlyPendingTimersAsync();
      await stop();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });
});
