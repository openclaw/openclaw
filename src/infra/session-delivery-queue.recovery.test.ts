// Covers session delivery queue recovery behavior.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { upsertDeliveryQueueEntry } from "./delivery-queue-sqlite.js";
const RECOVERY_REPLAY_SPACING_MS = 250;
import {
  deferSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDeliveries,
  moveSessionDeliveryToFailed,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
} from "./session-delivery-queue-storage.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  recoverPendingSessionDeliveries,
} from "./session-delivery-queue.js";

describe("session-delivery queue recovery", () => {
  it("replays and acks pending entries on recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(expect.any(Object), "recovered");
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("cleans an acknowledged tombstone without replaying delivery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-1:agent-loop",
        },
        tempDir,
      );
      const [entry] = await loadPendingSessionDeliveries(tempDir);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          ...entry,
          acknowledgedAt: Date.now(),
          retryCount: 99,
          lastAttemptAt: Date.now(),
          availableAt: Date.now() + 60_000,
          maxRetries: 1,
        },
        stateDir: tempDir,
      });

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("drains an exhausted acknowledged tombstone without replay or backoff", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-drain-ack:agent-loop",
          maxRetries: 1,
        },
        tempDir,
      );
      const [entry] = await loadPendingSessionDeliveries(tempDir);
      if (!entry) {
        throw new Error("Expected pending session delivery");
      }
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: {
          ...entry,
          acknowledgedAt: Date.now(),
          retryCount: 1,
          lastAttemptAt: Date.now(),
          availableAt: Date.now() + 60_000,
        },
        stateDir: tempDir,
      });
      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);

      await drainPendingSessionDeliveries({
        drainKey: "test-acknowledged-cleanup",
        logLabel: "test acknowledged cleanup",
        deliver,
        onSettled,
        stateDir: tempDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        selectEntry: (candidate) => ({ match: candidate.id === id }),
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "recovered");
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("paces startup replay for multiple eligible session deliveries", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-04-23T00:00:00.000Z");
    vi.setSystemTime(startedAt);
    try {
      await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
        await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "first",
          },
          tempDir,
        );
        await enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "second",
          },
          tempDir,
        );

        let firstDelivered!: () => void;
        const firstDeliveredPromise = new Promise<void>((resolve) => {
          firstDelivered = resolve;
        });
        const deliveryTimes: number[] = [];
        const deliver = vi.fn(async () => {
          deliveryTimes.push(Date.now());
          if (deliveryTimes.length === 1) {
            firstDelivered();
          }
        });

        const recovery = recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        });
        await firstDeliveredPromise;
        expect(deliver).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(RECOVERY_REPLAY_SPACING_MS - 1);
        expect(deliver).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
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
      await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
        for (const text of ["first", "second", "third"]) {
          await enqueueSessionDelivery(
            {
              kind: "systemEvent",
              sessionKey: "agent:main:main",
              text,
            },
            tempDir,
          );
        }

        let firstDelivered!: () => void;
        const firstDeliveredPromise = new Promise<void>((resolve) => {
          firstDelivered = resolve;
        });
        const deliveryTimes: number[] = [];
        const deliver = vi.fn(async () => {
          deliveryTimes.push(Date.now());
          if (deliveryTimes.length === 1) {
            firstDelivered();
          }
        });

        const recovery = recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          maxRecoveryMs: 1,
          log: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          },
        });
        await firstDeliveredPromise;

        await vi.advanceTimersByTimeAsync(1);
        const summary = await recovery;

        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliveryTimes).toEqual([startedAt.getTime()]);
        expect(summary.recovered).toBe(1);
        expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers recovery when the recovery budget would exceed the date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MAX_DATE_TIMESTAMP_MS));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave queued",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const warn = vi.fn();
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
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
      expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(1);
    });

    vi.useRealTimers();
  });

  it("keeps failed entries queued with retry metadata for later recovery", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );

      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          throw new Error("transient failure");
        }),
        onSettled,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      expect(summary.failed).toBe(1);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("transient failure");
    });
  });

  it("defers active agent ownership without consuming retry budget", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-owned:agent-loop",
        },
        tempDir,
      );

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          await deferSessionDelivery(id, 1_000, tempDir);
          throw new SessionDeliveryDeferredError("agent run still active");
        }),
        stateDir: tempDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      const [entry] = await loadPendingSessionDeliveries(tempDir);
      expect(summary.failed).toBe(0);
      expect(entry?.retryCount).toBe(0);
      expect(entry?.availableAt).toBeGreaterThan(Date.now());
    });
  });

  it("does not report an explicitly dead-lettered delivery as recovered", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "generated image ready",
          messageId: "image:task-dead-lettered:agent-loop",
        },
        tempDir,
      );

      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          await moveSessionDeliveryToFailed(id, tempDir);
          throw new SessionDeliveryDeadLetteredError("ambiguous side effects");
        }),
        onSettled,
        stateDir: tempDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(summary.recovered).toBe(0);
      expect(summary.failed).toBe(0);
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "moved-to-failed");
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("uses the entry retry budget when draining entries", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          maxRetries: 20,
        },
        tempDir,
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await failSessionDelivery(id, "busy", tempDir);
      }

      const deliver = vi.fn(async () => undefined);
      await drainPendingSessionDeliveries({
        drainKey: "test-restart-continuation",
        logLabel: "test restart continuation",
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        selectEntry: (entry) => ({
          match: entry.id === id,
          bypassBackoff: true,
        }),
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("settles entries moved to failed after drain retry exhaustion", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:drain-exhausted",
          maxRetries: 1,
        },
        tempDir,
      );
      await failSessionDelivery(id, "busy", tempDir);

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      await drainPendingSessionDeliveries({
        drainKey: "test-restart-continuation-exhausted",
        logLabel: "test restart continuation",
        deliver,
        onSettled,
        stateDir: tempDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "moved-to-failed");
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("settles entries moved to failed after startup retry exhaustion", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:startup-exhausted",
          maxRetries: 1,
        },
        tempDir,
      );
      await failSessionDelivery(id, "busy", tempDir);

      const deliver = vi.fn(async () => undefined);
      const onSettled = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        onSettled,
        stateDir: tempDir,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(summary.skippedMaxRetries).toBe(1);
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "moved-to-failed");
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });

  it("skips entries queued after the startup recovery cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "recover old entry",
        },
        tempDir,
      );
      const maxEnqueuedAt = Date.now();

      vi.setSystemTime(new Date("2026-04-23T00:00:05.000Z"));
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "leave fresh entry queued",
        },
        tempDir,
      );

      const deliver = vi.fn(async () => undefined);
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        maxEnqueuedAt,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      const pending = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe("systemEvent");
      if (pending[0]?.kind === "systemEvent") {
        expect(pending[0].text).toBe("leave fresh entry queued");
      }
    });

    vi.useRealTimers();
  });
});
