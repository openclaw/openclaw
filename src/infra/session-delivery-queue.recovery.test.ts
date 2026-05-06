import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { __resetFailedGcWatermarkForTests } from "./session-delivery-queue-recovery.js";
import * as storage from "./session-delivery-queue-storage.js";
import {
  enqueueSessionDelivery,
  enqueuePostCompactionDelegateDelivery,
  failSessionDelivery,
  isSessionDeliveryEligibleForRetry,
  loadPendingSessionDeliveries,
  recoverPendingSessionDeliveries,
  resolveSessionDeliveryQueueDir,
} from "./session-delivery-queue.js";

describe("session-delivery queue recovery", () => {
  beforeEach(() => {
    __resetFailedGcWatermarkForTests();
  });
  afterEach(() => {
    __resetFailedGcWatermarkForTests();
  });

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
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
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

  it("amortizes failed/ prune across rapid recovery ticks via the lastGcAt watermark", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const failedDir = path.join(resolveSessionDeliveryQueueDir(tempDir), "failed");
      fs.mkdirSync(failedDir, { recursive: true });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const deliver = vi.fn(async () => undefined);

      const pruneSpy = vi
        .spyOn(storage, "pruneFailedOlderThan")
        .mockResolvedValue({ scanned: 0, removed: 0 });
      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(1_700_000_000_000);
        await recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          log,
          failedMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
        });
        expect(pruneSpy).toHaveBeenCalledTimes(1);

        // Same wall-clock — within the 60s amortization window — must NOT re-prune.
        await recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          log,
          failedMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
        });
        expect(pruneSpy).toHaveBeenCalledTimes(1);

        // Advance past the amortization window — next tick should prune again.
        nowSpy.mockReturnValue(1_700_000_000_000 + 61_000);
        await recoverPendingSessionDeliveries({
          deliver,
          stateDir: tempDir,
          log,
          failedMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
        });
        expect(pruneSpy).toHaveBeenCalledTimes(2);
      } finally {
        pruneSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });
  });

  it("skips failed/ prune entirely when failedMaxAgeMs is not provided", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const pruneSpy = vi
        .spyOn(storage, "pruneFailedOlderThan")
        .mockResolvedValue({ scanned: 0, removed: 0 });
      try {
        await recoverPendingSessionDeliveries({
          deliver: vi.fn(async () => undefined),
          stateDir: tempDir,
          log,
        });
        expect(pruneSpy).not.toHaveBeenCalled();
      } finally {
        pruneSpy.mockRestore();
      }
    });
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
      expect(failedEntry).toBeDefined();
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastAttemptAt).toBeDefined();

      const lastAttemptAt = failedEntry?.lastAttemptAt ?? 0;
      const notReady = isSessionDeliveryEligibleForRetry(failedEntry, lastAttemptAt + 4_999);
      expect(notReady).toEqual({ eligible: false, remainingBackoffMs: 1 });

      const ready = isSessionDeliveryEligibleForRetry(failedEntry, lastAttemptAt + 5_000);
      expect(ready).toEqual({ eligible: true });
    });

    vi.useRealTimers();
  });

  it("logs retry-budget exhaustion for post-compaction delegates before spawn", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueuePostCompactionDelegateDelivery(
        {
          sessionKey: "agent:main:main",
          delegate: {
            task: "carry state forward",
            createdAt: 123,
            silent: true,
            silentWake: true,
          },
          sequence: 0,
        },
        tempDir,
      );
      for (let i = 0; i < 5; i += 1) {
        await failSessionDelivery(id, `spawn failed ${i}`, tempDir);
      }
      const log = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const summary = await recoverPendingSessionDeliveries({
        deliver: vi.fn(async () => undefined),
        stateDir: tempDir,
        log,
      });

      expect(summary.skippedMaxRetries).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("[session-delivery-queue:retry-budget-exhausted] entry"),
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "hit retry cap before post-compaction delegate spawn for session agent:main:main: carry state forward",
        ),
      );
      expect(await loadPendingSessionDeliveries(tempDir)).toEqual([]);
    });
  });
});
