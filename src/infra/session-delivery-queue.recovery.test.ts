// Covers session delivery queue recovery behavior.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../test/helpers/infra/delivery-recovery.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";
const RECOVERY_REPLAY_SPACING_MS = 250;
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());

vi.mock("../utils/sleep.js", () => ({ sleep: sleepMock }));

import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue-recovery.js";
import {
  deferSessionDelivery,
  enqueueSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDeliveries,
  markSessionDeliveryAttemptStarted,
} from "./session-delivery-queue-storage.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";

describe("session-delivery queue recovery", () => {
  beforeEach(() => {
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  it("replays and acks pending entries on recovery", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        queueContext,
      );

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        queueContext,
        log: createInfoWarnErrorLogger(),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(expect.any(Object), "recovered", queueContext);
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("lets the delivery owner persist its fence at the side-effect boundary", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-preflight-owner:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async (entry, context) => {
        expect(context).toEqual({ queueContext });
        await markSessionDeliveryAttemptStarted(entry, queueContext);
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
          expect.objectContaining({ id, deliveryStartedAt: expect.any(Number) }),
        ]);
      });

      await recoverPendingSessionDeliveries({
        deliver,
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("retries settlement cleanup without replaying a delivered side effect", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-settlement-retry:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => undefined);
      let failCleanup = true;
      const onSettled = vi.fn(async () => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error("cleanup interrupted");
        }
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const first = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        queueContext,
        log,
      });

      expect(first.recovered).toBe(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({
          id,
          acknowledgedAt: expect.any(Number),
          settlementOutcome: "recovered",
        }),
      ]);

      const second = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        queueContext,
        log,
      });

      expect(second.recovered).toBe(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("retries dead-letter cleanup without replaying an ambiguous agent turn", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-dead-letter-cleanup:agent-loop",
        },
        queueContext,
      );
      const deliver = vi.fn(async () => {
        throw new SessionDeliveryDeadLetteredError("ambiguous side effects");
      });
      let failCleanup = true;
      const onSettled = vi.fn(async () => {
        if (failCleanup) {
          failCleanup = false;
          throw new Error("cleanup interrupted");
        }
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await recoverPendingSessionDeliveries({ deliver, onSettled, queueContext, log });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({ id, settlementOutcome: "moved-to-failed" }),
      ]);

      await recoverPendingSessionDeliveries({ deliver, onSettled, queueContext, log });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(2);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("cleans an acknowledged tombstone without replaying delivery", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-1:agent-loop",
        },
        queueContext,
      );
      const [entry] = await loadPendingSessionDeliveries(queueContext);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      seedDeliveryQueueEntry({
        queueName: "session",
        entry: {
          ...entry,
          acknowledgedAt: Date.now(),
          retryCount: 99,
          lastAttemptAt: Date.now(),
          availableAt: Date.now() + 60_000,
          maxRetries: 1,
        } as QueuedSessionDelivery,
        stateDir: tempDir,
      });

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        queueContext,
        log: createInfoWarnErrorLogger(),
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("drains an exhausted acknowledged tombstone without replay or backoff", async () => {
    await withSessionDeliveryQueue(async (tempDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-drain-ack:agent-loop",
          maxRetries: 1,
        },
        queueContext,
      );
      const [entry] = await loadPendingSessionDeliveries(queueContext);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      seedDeliveryQueueEntry({
        queueName: "session",
        entry: {
          ...entry,
          acknowledgedAt: Date.now(),
          retryCount: 1,
          lastAttemptAt: Date.now(),
          availableAt: Date.now() + 60_000,
        } as QueuedSessionDelivery,
        stateDir: tempDir,
      });
      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);

      await drainPendingSessionDelivery({
        id,
        logLabel: "test acknowledged cleanup",
        deliver,
        onSettled,
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        "recovered",
        queueContext,
      );
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("paces startup replay for multiple eligible session deliveries", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "first",
          },
          queueContext,
        );
        await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "second",
          },
          queueContext,
        );

        const deliveryTimes: number[] = [];
        const deliver = vi.fn(async () => {
          deliveryTimes.push(Date.now());
        });

        const recovery = recoverPendingSessionDeliveries({
          deliver,
          queueContext,
          log: createInfoWarnErrorLogger(),
        });

        await expect(controlledSleep.started).resolves.toBe(RECOVERY_REPLAY_SPACING_MS);
        expect(deliver).toHaveBeenCalledTimes(1);
        controlledSleep.release();
        const summary = await recovery;

        expect(deliver).toHaveBeenCalledTimes(2);
        expect(deliveryTimes[1]).toBe(startedAt.getTime() + RECOVERY_REPLAY_SPACING_MS);
        expect(summary.recovered).toBe(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts replay pacing against the session recovery budget", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      const controlledSleep = controlNextRecoverySleep(sleepMock);
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        for (const text of ["first", "second", "third"]) {
          await enqueueSessionDelivery(
            {
              kind: "systemEvent",
              sessionKey: "agent:main:main",
              text,
            },
            queueContext,
          );
        }

        const deliveryTimes: number[] = [];
        const deliver = vi.fn(async () => {
          deliveryTimes.push(Date.now());
        });

        const recovery = recoverPendingSessionDeliveries({
          deliver,
          queueContext,
          maxRecoveryMs: 1,
          log: createInfoWarnErrorLogger(),
        });

        await expect(controlledSleep.started).resolves.toBe(1);
        expect(deliver).toHaveBeenCalledTimes(1);
        controlledSleep.release();
        const summary = await recovery;

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliveryTimes).toEqual([startedAt.getTime()]);
        expect(summary.recovered).toBe(1);
        expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers recovery when the recovery budget would exceed the date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave queued",
        },
        queueContext,
      );

      const deliver = vi.fn(async () => undefined);
      const warn = vi.fn();
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        queueContext,
        maxRecoveryMs: 1,
        log: {
          info: vi.fn(),
          warn,
          error: vi.fn(),
        },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Session delivery recovery time budget exceeded — remaining entries deferred",
      );
      expect(summary.recovered).toBe(0);
      expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(1);
    });

    vi.useRealTimers();
  });

  it("keeps failed entries queued with retry metadata for later recovery", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        queueContext,
      );

      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async (entry) => {
          await markSessionDeliveryAttemptStarted(entry, queueContext);
          throw new Error("transient failure");
        }),
        onSettled,
        queueContext,
        log: createInfoWarnErrorLogger(),
      });

      const [failedEntry] = await loadPendingSessionDeliveries(queueContext);
      expect(summary.failed).toBe(1);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("transient failure");
      expect(failedEntry?.deliveryStartedAt).toEqual(expect.any(Number));
    });
  });

  it("leaves pre-dispatch failures retryable without claiming side-effect ownership", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:pre-dispatch-failure",
        },
        queueContext,
      );

      await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          throw new Error("session lookup unavailable");
        }),
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({ retryCount: 1, lastError: "session lookup unavailable" }),
      ]);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.not.objectContaining({ deliveryStartedAt: expect.any(Number) }),
      ]);
    });
  });

  it("releases attempt ownership only for an explicitly safe retry", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:safe-retry",
        },
        queueContext,
      );

      await recoverPendingSessionDeliveries({
        deliver: vi.fn(async (entry) => {
          await markSessionDeliveryAttemptStarted(entry, queueContext);
          throw new SessionDeliverySafeRetryError("busy before agent start");
        }),
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.not.objectContaining({ deliveryStartedAt: expect.any(Number) }),
      ]);
    });
  });

  it("defers active agent ownership without consuming retry budget", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-owned:agent-loop",
        },
        queueContext,
      );

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          await deferSessionDelivery(id, 1_000, queueContext);
          throw new SessionDeliveryDeferredError("agent run still active");
        }),
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const [entry] = await loadPendingSessionDeliveries(queueContext);
      expect(summary.failed).toBe(0);
      expect(entry?.retryCount).toBe(0);
      expect(entry?.availableAt).toBeGreaterThan(Date.now());
    });
  });

  it("does not charge retry budget twice after a charged transition failure", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-charged-transition:agent-loop",
        },
        queueContext,
      );
      const summary = await recoverPendingSessionDeliveries({
        queueContext,
        deliver: async () => {
          await failSessionDelivery(id, "terminal attempt failed", queueContext);
          throw new SessionDeliveryRetryChargedError("advance failed after retry charge");
        },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(summary.failed).toBe(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({
          id,
          retryCount: 1,
          lastChargedAgentRunAttempt: 0,
        }),
      ]);
    });
  });

  it("does not report an explicitly dead-lettered delivery as recovered", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-dead-lettered:agent-loop",
        },
        queueContext,
      );

      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          throw new SessionDeliveryDeadLetteredError("ambiguous side effects");
        }),
        onSettled,
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(summary.recovered).toBe(0);
      expect(summary.failed).toBe(0);
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        "moved-to-failed",
        queueContext,
      );
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("uses the entry retry budget when draining entries", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          maxRetries: 20,
        },
        queueContext,
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await failSessionDelivery(id, "busy", queueContext);
      }

      const deliver = vi.fn(async () => undefined);
      await drainPendingSessionDelivery({
        id,
        logLabel: "test restart continuation",
        bypassBackoff: true,
        deliver,
        queueContext,
        log: createInfoWarnErrorLogger(),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("settles entries moved to failed after drain retry exhaustion", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:drain-exhausted",
          maxRetries: 1,
        },
        queueContext,
      );
      await failSessionDelivery(id, "busy", queueContext);

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      await drainPendingSessionDelivery({
        id,
        logLabel: "test restart continuation",
        bypassBackoff: true,
        deliver,
        onSettled,
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        "moved-to-failed",
        queueContext,
      );
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("settles entries moved to failed after startup retry exhaustion", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:startup-exhausted",
          maxRetries: 1,
        },
        queueContext,
      );
      await failSessionDelivery(id, "busy", queueContext);

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        queueContext,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(summary.skippedMaxRetries).toBe(1);
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ id }),
        "moved-to-failed",
        queueContext,
      );
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it.each(["runtime", "startup"] as const)(
    "reconciles an accepted agent turn before %s retry exhaustion",
    async (mode) => {
      if (mode === "startup") {
        vi.useFakeTimers();
      }
      try {
        await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
          const id = await enqueueSessionDelivery(
            {
              kind: "agentTurn",
              sessionKey: "agent:main:main",
              message: "generated image ready",
              messageId: `image:task-exhausted-${mode}:agent-loop`,
              maxRetries: 1,
            },
            queueContext,
          );
          const entry = await loadPendingSessionDeliveries(queueContext).then(
            (entries) => entries[0],
          );
          if (!entry) {
            throw new Error("Expected pending session delivery");
          }
          await markSessionDeliveryAttemptStarted(entry, queueContext);
          await failSessionDelivery(id, "final response lost", queueContext);

          const deliver = vi.fn(async () => undefined);
          if (mode === "startup") {
            const [pending] = await loadPendingSessionDeliveries(queueContext);
            if (pending?.lastAttemptAt === undefined) {
              throw new Error("Expected the worker to persist the failed attempt timestamp");
            }
            vi.setSystemTime(new Date(pending.lastAttemptAt + 60_000));
          }
          if (mode === "runtime") {
            await drainPendingSessionDelivery({
              id,
              logLabel: "test started reconciliation",
              bypassBackoff: true,
              deliver,
              queueContext,
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            });
          } else {
            const summary = await recoverPendingSessionDeliveries({
              deliver,
              queueContext,
              log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            });
            expect(summary.skippedMaxRetries).toBe(0);
          }

          expect(deliver).toHaveBeenCalledWith(
            expect.objectContaining({ id, deliveryStartedAt: expect.any(Number) }),
            { queueContext },
          );
          expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
        });
      } finally {
        if (mode === "startup") {
          vi.useRealTimers();
        }
      }
    },
  );

  it("dead-letters a started agent turn after its bounded reconciliation fails", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-reconciliation-failed:agent-loop",
          maxRetries: 1,
        },
        queueContext,
      );
      const [entry] = await loadPendingSessionDeliveries(queueContext);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      await markSessionDeliveryAttemptStarted(entry, queueContext);
      await failSessionDelivery(id, "final response lost", queueContext);

      const deliver = vi.fn(async () => {
        throw new Error("terminal evidence unavailable");
      });
      const drain = async () =>
        await drainPendingSessionDelivery({
          id,
          logLabel: "test started reconciliation",
          bypassBackoff: true,
          deliver,
          queueContext,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });

      await drain();
      expect(deliver).toHaveBeenCalledOnce();
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({ id, retryCount: 2, deliveryStartedAt: expect.any(Number) }),
      ]);

      await drain();
      expect(deliver).toHaveBeenCalledOnce();
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it("skips entries queued after the startup recovery cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover old entry",
        },
        queueContext,
      );
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave fresh entry queued",
        },
        queueContext,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        queueContext,
        maxEnqueuedAt,
        log: createInfoWarnErrorLogger(),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await loadPendingSessionDeliveries(queueContext);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe("systemEvent");
      if (pending[0]?.kind === "systemEvent") {
        expect(pending[0].text).toBe("leave fresh entry queued");
      }
    });

    vi.useRealTimers();
  });
});
