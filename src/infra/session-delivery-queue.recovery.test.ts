import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlNextRecoverySleep } from "../../test/helpers/infra/delivery-recovery.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import {
  enqueueUnclaimedSessionDeliveryFixture as enqueueSessionDelivery,
  withSessionDeliveryQueue,
} from "./session-delivery-queue.test-helpers.js";
const RECOVERY_REPLAY_SPACING_MS = 250;
const sleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());

vi.mock("../utils/sleep.js", () => ({ sleep: sleepMock }));

import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import {
  drainPendingSessionDelivery as drainEntry,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue-recovery.js";
import {
  deferSessionDelivery as defer,
  failSessionDelivery as fail,
  loadPendingSessionDeliveries as listPending,
  markSessionDeliveryAttemptStarted as markStarted,
} from "./session-delivery-queue-storage.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  SessionDeliverySafeRetryError,
} from "./session-delivery-queue.records.js";

type QueueContext = NonNullable<Parameters<typeof enqueueSessionDelivery>[1]>;
type AgentTurn = Extract<Parameters<typeof enqueueSessionDelivery>[0], { kind: "agentTurn" }>;
type RecoveryOptions = Omit<
  Parameters<typeof recoverPendingSessionDeliveries>[0],
  "queueContext" | "log"
> &
  Partial<Pick<Parameters<typeof recoverPendingSessionDeliveries>[0], "log">>;
type DrainOptions = Omit<Parameters<typeof drainEntry>[0], "queueContext" | "log" | "logLabel"> &
  Partial<Pick<Parameters<typeof drainEntry>[0], "log" | "logLabel">>;
function queueFixture(context: QueueContext, stateDir: string) {
  const defaults = () => ({ queueContext: context, log: createInfoWarnErrorLogger() });
  const pending = () => listPending(context);
  const drain = (options: DrainOptions) =>
    drainEntry({ ...defaults(), logLabel: "test restart continuation", ...options });
  return {
    context,
    pending,
    drain,
    recover: (options: RecoveryOptions) =>
      recoverPendingSessionDeliveries({ ...defaults(), ...options }),
    drainNow: (id: string, deliver: DrainOptions["deliver"], options: Partial<DrainOptions> = {}) =>
      drain({ id, deliver, bypassBackoff: true, ...options }),
    turn: (messageId: string, overrides: Partial<AgentTurn> = {}) =>
      enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          expectedMediaUrls: ["/tmp/synthetic-image.png"],
          messageId,
          ...overrides,
        },
        context,
      ),
    event: (text: string) =>
      enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: text,
          messageId: text,
          expectedMediaUrls: ["/tmp/synthetic-image.png"],
        },
        context,
      ),
    seed: (entry: Parameters<typeof seedDeliveryQueueEntry>[0]["entry"]) =>
      seedDeliveryQueueEntry({ queueName: "session", stateDir, entry }),
    started: (entry: Parameters<typeof markStarted>[0]) => markStarted(entry, context),
    fail: (id: string, error: string) => fail(id, error, context),
    defer: (id: string, delay: number) => defer(id, delay, context),
    async first() {
      const [entry] = await pending();
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      return entry;
    },
    async expectPending(...entries: object[]) {
      expect(await pending()).toEqual(entries.map((entry) => expect.objectContaining(entry)));
    },
  };
}
function withQueue(run: (queue: ReturnType<typeof queueFixture>) => Promise<void>) {
  return withSessionDeliveryQueue((stateDir, context) => run(queueFixture(context, stateDir)));
}

describe("session-delivery queue recovery", () => {
  beforeEach(() => {
    sleepMock.mockReset();
    sleepMock.mockResolvedValue(undefined);
  });

  it.each([
    { mode: "recovery", terminal: false },
    { mode: "recovery", terminal: true },
    { mode: "exact", terminal: true },
  ] as const)(
    "retries $mode settlement cleanup (terminal: $terminal) without replay",
    async ({ mode, terminal }) => {
      await withQueue(async (q) => {
        const id = await q.turn("image:task-settlement-retry:agent-loop");
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
        const options = { deliver, onSettled, log };
        const drain = () =>
          mode === "recovery"
            ? q.recover(options)
            : q.drain({ ...options, id, logLabel: "Session delivery" });
        const count = terminal ? "failed" : "recovered";
        const outcome = terminal ? "moved-to-failed" : "recovered";
        expect(await drain()).toEqual(
          expect.objectContaining(mode === "recovery" ? { [count]: 0 } : { id }),
        );
        expect(deliver).toHaveBeenCalledTimes(1);
        await q.expectPending({
          id,
          settlementOutcome: outcome,
          ...(!terminal ? { acknowledgedAt: expect.any(Number) } : {}),
        });
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
        expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), outcome, q.context);
        await q.expectPending();
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
      await withQueue(async (q) => {
        const id = await q.turn("image:task-drain-ack:agent-loop", {
          maxRetries: 1,
        });
        q.seed({
          ...(await q.first()),
          acknowledgedAt: Date.now(),
          retryCount: mode === "recovery" ? 99 : 1,
          lastAttemptAt: Date.now(),
          availableAt: Date.now() + 60_000,
        });
        const deliver = vi.fn(async () => undefined);
        const onSettled = vi.fn(async () => undefined);
        if (mode === "recovery") {
          expect(await q.recover({ deliver, onSettled })).toMatchObject({
            recovered: 1,
          });
        } else {
          await q.drain({
            id,
            logLabel: "test acknowledged cleanup",
            deliver,
            onSettled,
          });
        }
        expect(deliver).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          "recovered",
          q.context,
        );
        expect(await q.pending()).toStrictEqual([]);
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
        await withQueue(async (q) => {
          for (const text of ["first", "second", "third"].slice(0, count)) {
            await q.event(text);
          }
          const deliveryTimes: number[] = [];
          const deliver = vi.fn(async () => {
            deliveryTimes.push(Date.now());
          });
          const recovery = q.recover({ deliver, maxRecoveryMs: budget });
          await expect(controlledSleep.started).resolves.toBe(spacing);
          expect(deliver).toHaveBeenCalledTimes(1);
          controlledSleep.release();
          expect(await recovery).toMatchObject({ recovered });
          expect(deliver).toHaveBeenCalledTimes(recovered);
          expect(deliveryTimes).toEqual(
            recovered === 1 ? [startedAt] : [startedAt, startedAt + spacing],
          );
          expect(await q.pending()).toHaveLength(count - recovered);
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("defers recovery when the recovery budget would exceed the date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    await withQueue(async (q) => {
      await q.event("leave queued");

      const deliver = vi.fn(async () => undefined);
      const warn = vi.fn();
      const summary = await q.recover({
        deliver,
        maxRecoveryMs: 1,
        log: { info: vi.fn(), warn, error: vi.fn() },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Session delivery recovery time budget exceeded — remaining entries deferred",
      );
      expect(summary.recovered).toBe(0);
      expect(await q.pending()).toHaveLength(1);
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
      await withQueue(async (q) => {
        const id = await q.turn(messageId, { message: "continue" });
        const log = createInfoWarnErrorLogger();
        const summary = await q.recover({
          deliver: vi.fn(async (entry) => {
            if (started) {
              await q.started(entry);
            }
            throw safe ? new SessionDeliverySafeRetryError(failure) : new Error(failure);
          }),
          onSettled: vi.fn(async () => undefined),
          log,
        });
        expect(summary.failed).toBe(1);
        const pending = await q.pending();
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
    await withQueue(async (q) => {
      const id = await q.turn("image:task-owned:agent-loop");

      const summary = await q.recover({
        deliver: vi.fn(async () => {
          await q.defer(id, 1_000);
          throw new SessionDeliveryDeferredError("agent run still active");
        }),
      });

      const [entry] = await q.pending();
      expect(summary.failed).toBe(0);
      expect(entry?.retryCount).toBe(0);
      expect(entry?.availableAt).toBeGreaterThan(Date.now());
    });
  });

  it("does not charge retry budget twice after a charged transition failure", async () => {
    await withQueue(async (q) => {
      const id = await q.turn("image:task-charged-transition:agent-loop");
      const summary = await q.recover({
        deliver: async () => {
          await q.fail(id, "terminal attempt failed");
          throw new SessionDeliveryRetryChargedError("advance failed after retry charge");
        },
      });

      expect(summary.failed).toBe(1);
      await q.expectPending({ id, retryCount: 1 });
    });
  });

  it.each(["recovery", "exact"] as const)(
    "reports the redacted terminal reason and queue ID through %s without queue content",
    async (mode) => {
      await withQueue(async (q) => {
        const token = "sk-abcdefghijklmnopqrstuv";
        const id = await q.turn("image:task-dead-lettered:agent-loop", {
          sessionKey: "agent:main:private-session",
          message: "private queued message",
          route: { channel: "test", to: "private-recipient", chatType: "direct" },
        });
        const entry = await q.first();
        q.seed({ ...entry, lastError: "previous retry failure" });

        const onSettled = vi.fn(async () => undefined);
        const log = createInfoWarnErrorLogger();
        const options = {
          deliver: vi.fn(async () => {
            throw new SessionDeliveryDeadLetteredError(
              `ambiguous side effects; Authorization: Bearer ${token}`,
            );
          }),
          onSettled,
          log,
        };

        if (mode === "recovery") {
          const summary = await q.recover(options);
          expect(summary).toMatchObject({ recovered: 0, failed: 1 });
        } else {
          expect(await q.drain({ ...options, id, logLabel: "Session delivery" })).toBeNull();
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
          q.context,
        );
        expect(await q.pending()).toStrictEqual([]);
        expect((await q.recover(options)).failed).toBe(0);
        expect(options.deliver).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("uses the entry retry budget when draining entries", async () => {
    await withQueue(async (q) => {
      const id = await q.turn("restart-sentinel:agent:main:main:agentTurn:123", {
        message: "continue",
        maxRetries: 20,
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await q.fail(id, "busy");
      }

      const deliver = vi.fn(async () => undefined);
      await q.drainNow(id, deliver);

      expect(deliver).toHaveBeenCalledTimes(1);
      await q.expectPending();
    });
  });

  it.each(["drain", "startup"] as const)(
    "settles entries moved to failed after %s retry exhaustion",
    async (mode) => {
      await withQueue(async (q) => {
        const id = await q.turn(`restart-sentinel:agent:main:main:agentTurn:${mode}-exhausted`, {
          message: "continue",
          maxRetries: 1,
        });
        await q.fail(id, "busy");
        const deliver = vi.fn(async () => undefined);
        const onSettled = vi.fn(async () => undefined);
        if (mode === "startup") {
          expect(await q.recover({ deliver, onSettled })).toMatchObject({
            skippedMaxRetries: 1,
          });
        } else {
          await q.drainNow(id, deliver, { onSettled });
        }
        expect(deliver).not.toHaveBeenCalled();
        expect(onSettled).toHaveBeenCalledWith(
          expect.objectContaining({ id }),
          "moved-to-failed",
          q.context,
        );
        await q.expectPending();
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
        await withQueue(async (q) => {
          const id = await q.turn(`image:task-exhausted-${mode}:agent-loop`, {
            maxRetries: 1,
          });
          const entry = await q.first();
          await q.started(entry);
          await q.fail(id, "final response lost");

          const deliver = vi.fn(async () => undefined);
          if (mode === "startup") {
            const [pending] = await q.pending();
            if (pending?.lastAttemptAt === undefined) {
              throw new Error("Expected the worker to persist the failed attempt timestamp");
            }
            vi.setSystemTime(new Date(pending.lastAttemptAt + 60_000));
          }
          if (mode === "runtime") {
            await q.drainNow(id, deliver, { logLabel: "test started reconciliation" });
          } else {
            const summary = await q.recover({ deliver });
            expect(summary.skippedMaxRetries).toBe(0);
          }

          expect(deliver).toHaveBeenCalledWith(
            expect.objectContaining({ id, deliveryStartedAt: expect.any(Number) }),
            { queueContext: q.context },
          );
          await q.expectPending();
        });
      } finally {
        if (mode === "startup") {
          vi.useRealTimers();
        }
      }
    },
  );

  it("dead-letters a started agent turn after its bounded reconciliation fails", async () => {
    await withQueue(async (q) => {
      const id = await q.turn("image:task-reconciliation-failed:agent-loop", {
        maxRetries: 1,
      });
      const entry = await q.first();
      await q.started(entry);
      await q.fail(id, "final response lost");

      const deliver = vi.fn(async () => {
        throw new Error("terminal evidence unavailable");
      });
      const drain = () => q.drainNow(id, deliver, { logLabel: "test started reconciliation" });

      await drain();
      expect(deliver).toHaveBeenCalledOnce();
      await q.expectPending({
        id,
        retryCount: 2,
        deliveryStartedAt: expect.any(Number),
      });

      await drain();
      expect(deliver).toHaveBeenCalledOnce();
      await q.expectPending();
    });
  });

  it("skips entries queued after the startup recovery cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withQueue(async (q) => {
      await q.event("recover old entry");
      q.seed({ ...(await q.first()), enqueuedAt: Date.now() - 6 * 24 * 60 * 60_000 });
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await q.event("leave fresh entry queued");

      const deliver = vi.fn(async () => undefined);
      const summary = await q.recover({ deliver, maxEnqueuedAt });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await q.pending();
      expect(pending).toEqual([
        expect.objectContaining({ kind: "agentTurn", message: "leave fresh entry queued" }),
      ]);
    });

    vi.useRealTimers();
  });
});
