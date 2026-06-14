// Covers session delivery queue recovery behavior.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  failSessionDelivery,
  isSessionDeliveryEligibleForRetry,
  loadPendingSessionDeliveries,
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
      const summary = await recoverPendingSessionDeliveries({
        deliver,
        stateDir: tempDir,
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("does not re-deliver a session entry whose delivery succeeded but ack was interrupted by a crash", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      // Stand-in for deliverQueuedSessionDelivery: the agent turn runs (signalling
      // onSendAttemptStart so recovery persists the send marker) and returns. With the
      // fix, recovery refuses a blind replay of this already-run turn, so it runs once.
      const deliver = vi.fn(async (_entry, hooks) => {
        await hooks?.onSendAttemptStart?.();
        deliverCount += 1;
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      // PASS 1: the turn runs but the ack is interrupted — models a crash after the
      // turn ran but before ackSessionDelivery. recovery.ts imports ackSessionDelivery
      // from the storage module, so spy that binding.
      const storage = await import("./session-delivery-queue-storage.js");
      const ackSpy = vi
        .spyOn(storage, "ackSessionDelivery")
        .mockImplementationOnce(async () => {
          throw new Error("simulated crash before ack");
        });
      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });
      ackSpy.mockRestore();

      // PASS 2: restart recovery re-enters and reloads the queue.
      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });

      // Without the fix: deliverCount === 2 (blind replay — turn re-run + reply
      // re-sent). With the fix: the turn reported onSendAttemptStart, so the ack
      // failure fail-safes the entry to failed/ rather than requeuing it → 1.
      expect(deliverCount).toBe(1);
    });
  });

  it("refuses to replay an entry recovered while still carrying the send marker (crash then fresh-process recovery)", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const storage = await import("./session-delivery-queue-storage.js");
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:456",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      // Model the durable state left by a crash that struck after the drain began
      // deliver but before ack: the send_attempt_started marker is persisted, the
      // entry is still pending, and the process restarted (no in-process delivered
      // flag survives). This is the real production scenario the fix guards.
      await storage.markSessionDeliveryPlatformSendAttemptStarted(id, tempDir);

      const deliver = vi.fn(async () => undefined);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const summary = await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });

      // Without the fix: recovery treats the pending entry as fresh and replays it
      // (deliver called, turn re-run + reply re-sent). With the fix: the recovered
      // send_attempt_started marker forces a fail-safe move to failed/ — no replay.
      expect(deliver).not.toHaveBeenCalled();
      expect(summary.recovered).toBe(0);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("refuses to replay a turn that sent before throwing (sent-before-error)", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:789",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      // The turn starts running (onSendAttemptStart) and may already have sent via the
      // message tool, then throws (a non-busy error after the send). This is the
      // sent-before-error path: recovery must NOT treat it as a pre-send failure.
      const deliver = vi.fn(async (_entry, hooks) => {
        await hooks?.onSendAttemptStart?.();
        deliverCount += 1;
        throw new Error("turn threw after sending");
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });
      // PASS 2: restart recovery re-enters.
      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });

      // Without the fix the catch clears the marker on the thrown deliver, so PASS 2
      // replays the already-sent turn (deliverCount === 2). With the fix the
      // sendAttempted signal fail-safes the entry to failed/ → delivered once.
      expect(deliverCount).toBe(1);
    });
  });

  it("retries a pre-send failure that never started the turn (at-least-once preserved)", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:abc",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      // The turn never starts (the deliver throws before reporting onSendAttemptStart),
      // e.g. a transient pre-send failure. Nothing ran or sent, so the entry must stay
      // retryable — fail-safe must NOT swallow a genuine pre-send failure.
      const deliver = vi.fn(async () => {
        deliverCount += 1;
        throw new Error("transient pre-send failure");
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });

      // The entry must stay pending with retry metadata and NO recovery marker — a
      // genuine pre-send failure is not fail-safed to failed/. (The subsequent retry
      // itself is gated by the normal backoff, covered by the backoff tests.)
      expect(deliverCount).toBe(1);
      const [pending] = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toBeDefined();
      expect(pending?.retryCount).toBe(1);
      expect(pending?.recoveryState).toBeUndefined();
    });
  });

  it("clears the send marker and stays retryable when the attempt is busy-deferred", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue",
          messageId: "restart-sentinel:agent:main:main:agentTurn:def",
          route: { channel: "telegram", to: "chat-1", chatType: "direct" },
        },
        tempDir,
      );

      let deliverCount = 0;
      // Model a busy continuation: the attempt starts (onSendAttemptStart persists the
      // marker), but the session is busy so the seam defers it (onSendDeferred clears
      // the marker) and throws the busy-retry error. No durable turn ran, so the entry
      // must stay retryable with the marker cleared — exercises the
      // clearSessionDeliveryRecoveryState() path.
      const deliver = vi.fn(async (_entry, hooks) => {
        deliverCount += 1;
        await hooks?.onSendAttemptStart?.();
        await hooks?.onSendDeferred?.();
        throw new Error("restart continuation busy; retry later");
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      await recoverPendingSessionDeliveries({ deliver, stateDir: tempDir, log });

      // Not moved to failed/ — the cleared marker leaves the entry retryable.
      expect(deliverCount).toBe(1);
      const [pending] = await loadPendingSessionDeliveries(tempDir);
      expect(pending).toBeDefined();
      expect(pending?.recoveryState).toBeUndefined();
      expect(pending?.retryCount).toBe(1);
    });
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

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => {
          throw new Error("transient failure");
        }),
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

  it("uses the persisted retryCount for the first backoff tier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));

    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "retry me",
        },
        tempDir,
      );
      await failSessionDelivery(id, "transient failure", tempDir);

      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      if (!failedEntry) {
        throw new Error("expected failed session delivery to remain pending");
      }
      expect(failedEntry.retryCount).toBe(1);

      const lastAttemptAt = failedEntry.lastAttemptAt;
      if (typeof lastAttemptAt !== "number") {
        throw new Error("expected failed delivery attempt timestamp");
      }
      const notReady = isSessionDeliveryEligibleForRetry(failedEntry, lastAttemptAt + 4_999);
      expect(notReady).toEqual({ eligible: false, remainingBackoffMs: 1 });

      const ready = isSessionDeliveryEligibleForRetry(failedEntry, lastAttemptAt + 5_000);
      expect(ready).toEqual({ eligible: true });
    });

    vi.useRealTimers();
  });
});
