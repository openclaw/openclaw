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
} from "./session-delivery-queue.records.js";

type QueueContext = Parameters<typeof enqueueSessionDelivery>[1];
type AgentTurn = Extract<Parameters<typeof enqueueSessionDelivery>[0], { kind: "agentTurn" }>;
const enqueueTurn = (
  queueContext: QueueContext,
  messageId: string,
  overrides: Partial<AgentTurn> = {},
) =>
  enqueueSessionDelivery(
    {
      kind: "agentTurn",
      sessionKey: "agent:main:main",
      message: "generated image ready",
      messageId,
      ...overrides,
    },
    queueContext,
  );
const enqueueEvent = (queueContext: QueueContext, text: string) =>
  enqueueSessionDelivery(
    { kind: "systemEvent", sessionKey: "agent:main:main", text },
    queueContext,
  );

function recover(
  queueContext: QueueContext,
  options: Omit<Parameters<typeof recoverPendingSessionDeliveries>[0], "queueContext" | "log">,
) {
  return recoverPendingSessionDeliveries({
    ...options,
    queueContext,
    log: createInfoWarnErrorLogger(),
  });
}
async function firstPending(queueContext: QueueContext) {
  const [entry] = await loadPendingSessionDeliveries(queueContext);
  if (!entry) {
    throw new Error("Expected pending session delivery");
  }
  return entry;
}

describe("session-delivery queue recovery", () => {
  beforeEach(() => {
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  it("replays and acks old SQLite entries on recovery", async () => {
    await withSessionDeliveryQueue(async (stateDir, queueContext) => {
      await enqueueEvent(queueContext, "restart complete");
      const entry = await firstPending(queueContext);
      seedDeliveryQueueEntry({
        queueName: "session",
        entry: { ...entry, enqueuedAt: Date.now() - 6 * 24 * 60 * 60_000 },
        stateDir,
      });

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      const summary = await recover(queueContext, { deliver, onSettled });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(expect.any(Object), "recovered", queueContext);
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
    });
  });

  it("lets the delivery owner persist its fence at the side-effect boundary", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueTurn(queueContext, "image:task-preflight-owner:agent-loop");
      const deliver = vi.fn(async (entry, context) => {
        expect(context).toEqual({ queueContext });
        await markSessionDeliveryAttemptStarted(entry, queueContext);
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
          expect.objectContaining({ id, deliveryStartedAt: expect.any(Number) }),
        ]);
      });

      await recover(queueContext, { deliver });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
    });
  });

  it.each([
    { mode: "recovery", terminal: false },
    { mode: "recovery", terminal: true },
    { mode: "exact", terminal: true },
  ] as const)(
    "retries $mode settlement cleanup (terminal: $terminal) without replay",
    async ({ mode, terminal }) => {
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        const id = await enqueueTurn(queueContext, "image:task-settlement-retry:agent-loop");
        const deliver = vi.fn(async () => {
          if (terminal) {
            throw new SessionDeliveryDeadLetteredError("ambiguous side effects");
          }
        });
        const onSettled = vi
          .fn<() => Promise<void>>()
          .mockRejectedValueOnce(new Error("cleanup interrupted"))
          .mockResolvedValue(undefined);
        const log = createInfoWarnErrorLogger();
        const options = { deliver, onSettled, queueContext, log };
        const drain = () =>
          mode === "recovery"
            ? recoverPendingSessionDeliveries(options)
            : drainPendingSessionDelivery({ ...options, id, logLabel: "Session delivery" });
        const count = terminal ? "failed" : "recovered";
        const outcome = terminal ? "moved-to-failed" : "recovered";
        expect(await drain()).toEqual(
          expect.objectContaining(mode === "recovery" ? { [count]: 0 } : { id }),
        );
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
          expect.objectContaining({
            id,
            settlementOutcome: outcome,
            ...(!terminal ? { acknowledgedAt: expect.any(Number) } : {}),
          }),
        ]);
        if (terminal) {
          expect(log.warn).toHaveBeenCalledExactlyOnceWith(
            `Session delivery: dead-letter decision for entry ${id}: ambiguous side effects`,
          );
        }
        expect(await drain()).toEqual(
          mode === "recovery" ? expect.objectContaining({ [count]: 1 }) : null,
        );
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(onSettled).toHaveBeenCalledTimes(2);
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          outcome,
          queueContext,
        );
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
        if (terminal) {
          expect(log.warn).toHaveBeenNthCalledWith(
            2,
            `Session delivery: entry ${id} was dead-lettered and moved to failed`,
          );
          expect(await drain()).toEqual(
            mode === "recovery" ? expect.objectContaining({ failed: 0 }) : null,
          );
          expect(deliver).toHaveBeenCalledTimes(1);
          expect(log.warn).toHaveBeenCalledTimes(2);
        }
      });
    },
  );

  it.each(["recovery", "exact"] as const)(
    "cleans exhausted acknowledged tombstones through %s without replay or backoff",
    async (mode) => {
      await withSessionDeliveryQueue(async (stateDir, queueContext) => {
        const id = await enqueueTurn(queueContext, "image:task-drain-ack:agent-loop", {
          maxRetries: 1,
        });
        seedDeliveryQueueEntry({
          queueName: "session",
          stateDir,
          entry: {
            ...(await firstPending(queueContext)),
            acknowledgedAt: Date.now(),
            retryCount: mode === "recovery" ? 99 : 1,
            lastAttemptAt: Date.now(),
            availableAt: Date.now() + 60_000,
          },
        });
        const deliver = vi.fn(async () => undefined);
        const onSettled = vi.fn(async () => undefined);
        if (mode === "recovery") {
          expect(await recover(queueContext, { deliver, onSettled })).toMatchObject({
            recovered: 1,
          });
        } else {
          await drainPendingSessionDelivery({
            id,
            logLabel: "test acknowledged cleanup",
            deliver,
            onSettled,
            queueContext,
            log: createInfoWarnErrorLogger(),
          });
        }
        expect(deliver).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          "recovered",
          queueContext,
        );
        expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
      });
    },
  );

  it.each([
    { budget: undefined, count: 2, spacing: RECOVERY_REPLAY_SPACING_MS, recovered: 2 },
    { budget: 1, count: 3, spacing: 1, recovered: 1 },
  ])(
    "paces startup replay within a $budget ms budget",
    async ({ budget, count, spacing, recovered }) => {
      vi.useFakeTimers();
      const startedAt = Date.UTC(2026, 3, 23);
      vi.setSystemTime(startedAt);
      try {
        const controlledSleep = controlNextRecoverySleep(sleepMock);
        await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
          for (const text of ["first", "second", "third"].slice(0, count)) {
            await enqueueEvent(queueContext, text);
          }
          const deliveryTimes: number[] = [];
          const deliver = vi.fn(async () => {
            deliveryTimes.push(Date.now());
          });
          const recovery = recover(queueContext, { deliver, maxRecoveryMs: budget });
          await expect(controlledSleep.started).resolves.toBe(spacing);
          expect(deliver).toHaveBeenCalledTimes(1);
          controlledSleep.release();
          expect(await recovery).toMatchObject({ recovered });
          expect(deliver).toHaveBeenCalledTimes(recovered);
          expect(deliveryTimes).toEqual(
            recovered === 1 ? [startedAt] : [startedAt, startedAt + spacing],
          );
          expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(count - recovered);
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("defers recovery when the recovery budget would exceed the date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      await enqueueEvent(queueContext, "leave queued");

      const deliver = vi.fn(async () => undefined);
      const warn = vi.fn();
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        queueContext,
        maxRecoveryMs: 1,
        log: { info: vi.fn(), warn, error: vi.fn() },
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

  it.each([
    {
      failure: "transient failure",
      started: true,
      safe: false,
      messageId: "restart-sentinel:agent:main:main:agentTurn:123",
    },
    {
      failure: "session lookup unavailable",
      started: false,
      safe: false,
      messageId: "restart-sentinel:pre-dispatch-failure",
    },
    {
      failure: "busy before agent start",
      started: true,
      safe: true,
      messageId: "restart-sentinel:safe-retry",
    },
  ])(
    "keeps $failure retryable with correct attempt ownership",
    async ({ failure, started, safe, messageId }) => {
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        const id = await enqueueTurn(queueContext, messageId, { message: "continue" });
        const log = createInfoWarnErrorLogger();
        const summary = await recoverPendingSessionDeliveries({
          deliver: vi.fn(async (entry) => {
            if (started) {
              await markSessionDeliveryAttemptStarted(entry, queueContext);
            }
            throw safe ? new SessionDeliverySafeRetryError(failure) : new Error(failure);
          }),
          onSettled: vi.fn(async () => undefined),
          queueContext,
          log,
        });
        expect(summary.failed).toBe(1);
        const pending = await loadPendingSessionDeliveries(queueContext);
        expect(pending).toEqual([expect.objectContaining({ retryCount: 1, lastError: failure })]);
        expect(pending).toEqual([
          started && !safe
            ? expect.objectContaining({ deliveryStartedAt: expect.any(Number) })
            : expect.not.objectContaining({ deliveryStartedAt: expect.any(Number) }),
        ]);
        if (started && !safe) {
          expect(log.warn).toHaveBeenCalledExactlyOnceWith(
            `Session delivery retry failed for entry ${id}: transient failure`,
          );
        }
      });
    },
  );

  it("defers active agent ownership without consuming retry budget", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueTurn(queueContext, "image:task-owned:agent-loop");

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          await deferSessionDelivery(id, 1_000, queueContext);
          throw new SessionDeliveryDeferredError("agent run still active");
        }),
        queueContext,
        log: createInfoWarnErrorLogger(),
      });

      const [entry] = await loadPendingSessionDeliveries(queueContext);
      expect(summary.failed).toBe(0);
      expect(entry?.retryCount).toBe(0);
      expect(entry?.availableAt).toBeGreaterThan(Date.now());
    });
  });

  it("does not charge retry budget twice after a charged transition failure", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueTurn(queueContext, "image:task-charged-transition:agent-loop");
      const summary = await recover(queueContext, {
        deliver: async () => {
          await failSessionDelivery(id, "terminal attempt failed", queueContext);
          throw new SessionDeliveryRetryChargedError("advance failed after retry charge");
        },
      });

      expect(summary.failed).toBe(1);
      expect(await loadPendingSessionDeliveries(queueContext)).toEqual([
        expect.objectContaining({ id, retryCount: 1, lastChargedAgentRunAttempt: 0 }),
      ]);
    });
  });

  it.each(["recovery", "exact"] as const)(
    "reports the redacted terminal reason and queue ID through %s without queue content",
    async (mode) => {
      await withSessionDeliveryQueue(async (stateDir, queueContext) => {
        const token = "sk-abcdefghijklmnopqrstuv";
        const id = await enqueueTurn(queueContext, "image:task-dead-lettered:agent-loop", {
          sessionKey: "agent:main:private-session",
          message: "private queued message",
          route: { channel: "test", to: "private-recipient", chatType: "direct" },
        });
        const entry = await firstPending(queueContext);
        seedDeliveryQueueEntry({
          queueName: "session",
          entry: { ...entry, lastError: "previous retry failure" },
          stateDir,
        });

        const onSettled = vi.fn(async () => undefined);
        const log = createInfoWarnErrorLogger();
        const options = {
          deliver: vi.fn(async () => {
            throw new SessionDeliveryDeadLetteredError(
              `ambiguous side effects; Authorization: Bearer ${token}`,
            );
          }),
          onSettled,
          queueContext,
          log,
        };

        if (mode === "recovery") {
          const summary = await recoverPendingSessionDeliveries(options);
          expect(summary).toMatchObject({ recovered: 0, failed: 1 });
        } else {
          expect(
            await drainPendingSessionDelivery({ ...options, id, logLabel: "Session delivery" }),
          ).toBeNull();
        }
        expect(log.warn).toHaveBeenNthCalledWith(
          1,
          expect.stringContaining(
            `Session delivery: dead-letter decision for entry ${id}: ambiguous side effects`,
          ),
        );
        expect(log.warn).toHaveBeenNthCalledWith(
          2,
          `Session delivery: entry ${id} was dead-lettered and moved to failed`,
        );
        const warnings = log.warn.mock.calls.flat().join("\n");
        for (const privateValue of [
          token,
          "agent:main:private-session",
          "private queued message",
          "private-recipient",
          "previous retry failure",
        ]) {
          expect(warnings).not.toContain(privateValue);
        }
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          "moved-to-failed",
          queueContext,
        );
        expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
        expect((await recoverPendingSessionDeliveries(options)).failed).toBe(0);
        expect(options.deliver).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("uses the entry retry budget when draining entries", async () => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueTurn(queueContext, "restart-sentinel:agent:main:main:agentTurn:123", {
        message: "continue",
        maxRetries: 20,
      });
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

  it.each(["drain", "startup"] as const)(
    "settles entries moved to failed after %s retry exhaustion",
    async (mode) => {
      await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
        const id = await enqueueTurn(
          queueContext,
          `restart-sentinel:agent:main:main:agentTurn:${mode}-exhausted`,
          { message: "continue", maxRetries: 1 },
        );
        await failSessionDelivery(id, "busy", queueContext);
        const deliver = vi.fn(async () => undefined);
        const onSettled = vi.fn(async () => undefined);
        if (mode === "startup") {
          expect(await recover(queueContext, { deliver, onSettled })).toMatchObject({
            skippedMaxRetries: 1,
          });
        } else {
          await drainPendingSessionDelivery({
            id,
            logLabel: "test restart continuation",
            bypassBackoff: true,
            deliver,
            onSettled,
            queueContext,
            log: createInfoWarnErrorLogger(),
          });
        }
        expect(deliver).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          "moved-to-failed",
          queueContext,
        );
        expect(await loadPendingSessionDeliveries(queueContext)).toEqual([]);
      });
    },
  );

  it.each(["runtime", "startup"] as const)(
    "reconciles an accepted agent turn before %s retry exhaustion",
    async (mode) => {
      if (mode === "startup") {
        vi.useFakeTimers();
      }
      try {
        await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
          const id = await enqueueTurn(queueContext, `image:task-exhausted-${mode}:agent-loop`, {
            maxRetries: 1,
          });
          const entry = await firstPending(queueContext);
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
              log: createInfoWarnErrorLogger(),
            });
          } else {
            const summary = await recover(queueContext, { deliver });
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
      const id = await enqueueTurn(queueContext, "image:task-reconciliation-failed:agent-loop", {
        maxRetries: 1,
      });
      const entry = await firstPending(queueContext);
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
          log: createInfoWarnErrorLogger(),
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
      await enqueueEvent(queueContext, "recover old entry");
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await enqueueEvent(queueContext, "leave fresh entry queued");

      const deliver = vi.fn(async () => undefined);
      const summary = await recover(queueContext, { deliver, maxEnqueuedAt });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await loadPendingSessionDeliveries(queueContext);
      expect(pending).toEqual([
        expect.objectContaining({ kind: "systemEvent", text: "leave fresh entry queued" }),
      ]);
    });

    vi.useRealTimers();
  });
});
