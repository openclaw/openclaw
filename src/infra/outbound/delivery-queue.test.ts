import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackDelivery,
  computeBackoffMs,
  type DeliverFn,
  enqueueDelivery,
  failDelivery,
  isEntryEligibleForRecoveryRetry,
  isPermanentDeliveryError,
  loadPendingDeliveries,
  MAX_RETRIES,
  moveToFailed,
  recoverPendingDeliveries,
} from "./delivery-queue.js";

describe("delivery-queue", () => {
  let tmpDir: string;
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dq-suite-"));
  });

  beforeEach(() => {
    tmpDir = path.join(fixtureRoot, `case-${fixtureCount++}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    if (!fixtureRoot) {
      return;
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  describe("enqueue + ack lifecycle", () => {
    it("creates and removes a queue entry", async () => {
      const id = await enqueueDelivery(
        {
          channel: "whatsapp",
          to: "+1555",
          payloads: [{ text: "hello" }],
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          mirror: {
            sessionKey: "agent:main:main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
          },
        },
        tmpDir,
      );

      const queueDir = path.join(tmpDir, "delivery-queue");
      const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${id}.json`);

      const entry = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), "utf-8"));
      expect(entry).toMatchObject({
        id,
        channel: "whatsapp",
        to: "+1555",
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        mirror: {
          sessionKey: "agent:main:main",
          text: "hello",
          mediaUrls: ["https://example.com/file.png"],
        },
        retryCount: 0,
      });
      expect(entry.payloads).toEqual([{ text: "hello" }]);

      await ackDelivery(id, tmpDir);
      const remaining = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
      expect(remaining).toHaveLength(0);
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir)).resolves.toBeUndefined();
    });

    it("ack cleans up leftover .delivered marker when .json is already gone", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "stale-marker" }] },
        tmpDir,
      );
      const queueDir = path.join(tmpDir, "delivery-queue");

      fs.renameSync(path.join(queueDir, `${id}.json`), path.join(queueDir, `${id}.delivered`));
      await expect(ackDelivery(id, tmpDir)).resolves.toBeUndefined();

      expect(fs.existsSync(path.join(queueDir, `${id}.delivered`))).toBe(false);
    });

    it("ack removes .delivered marker so recovery does not replay", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "ack-test" }] },
        tmpDir,
      );
      const queueDir = path.join(tmpDir, "delivery-queue");

      await ackDelivery(id, tmpDir);

      expect(fs.existsSync(path.join(queueDir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(queueDir, `${id}.delivered`))).toBe(false);
    });

    it("loadPendingDeliveries cleans up stale .delivered markers without replaying", async () => {
      const id = await enqueueDelivery(
        { channel: "telegram", to: "99", payloads: [{ text: "stale" }] },
        tmpDir,
      );
      const queueDir = path.join(tmpDir, "delivery-queue");

      fs.renameSync(path.join(queueDir, `${id}.json`), path.join(queueDir, `${id}.delivered`));

      const entries = await loadPendingDeliveries(tmpDir);

      expect(entries).toHaveLength(0);
      expect(fs.existsSync(path.join(queueDir, `${id}.delivered`))).toBe(false);
    });
  });

  describe("failDelivery", () => {
    it("increments retryCount, records attempt time, and sets lastError", async () => {
      const id = await enqueueDelivery(
        {
          channel: "telegram",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir,
      );

      await failDelivery(id, "connection refused", tmpDir);

      const queueDir = path.join(tmpDir, "delivery-queue");
      const entry = JSON.parse(fs.readFileSync(path.join(queueDir, `${id}.json`), "utf-8"));
      expect(entry.retryCount).toBe(1);
      expect(typeof entry.lastAttemptAt).toBe("number");
      expect(entry.lastAttemptAt).toBeGreaterThan(0);
      expect(entry.lastError).toBe("connection refused");
    });
  });

  describe("moveToFailed", () => {
    it("moves entry to failed/ subdirectory", async () => {
      const id = await enqueueDelivery(
        {
          channel: "slack",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir,
      );

      await moveToFailed(id, tmpDir);

      const queueDir = path.join(tmpDir, "delivery-queue");
      const failedDir = path.join(queueDir, "failed");
      expect(fs.existsSync(path.join(queueDir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
    });
  });

  describe("isPermanentDeliveryError", () => {
    it.each([
      "No conversation reference found for user:abc",
      "Telegram send failed: chat not found (chat_id=user:123)",
      "user not found",
      "Bot was blocked by the user",
      "Forbidden: bot was kicked from the group chat",
      "chat_id is empty",
      "Outbound not configured for channel: msteams",
    ])("returns true for permanent error: %s", (msg) => {
      expect(isPermanentDeliveryError(msg)).toBe(true);
    });

    it.each([
      "network down",
      "ETIMEDOUT",
      "socket hang up",
      "rate limited",
      "500 Internal Server Error",
    ])("returns false for transient error: %s", (msg) => {
      expect(isPermanentDeliveryError(msg)).toBe(false);
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array when queue directory does not exist", async () => {
      const nonexistent = path.join(tmpDir, "no-such-dir");
      const entries = await loadPendingDeliveries(nonexistent);
      expect(entries).toEqual([]);
    });

    it("loads multiple entries", async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);
      await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir);

      const entries = await loadPendingDeliveries(tmpDir);
      expect(entries).toHaveLength(2);
    });

    it("backfills lastAttemptAt for legacy retry entries during load", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "legacy" }] },
        tmpDir,
      );
      const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
      const legacyEntry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      legacyEntry.retryCount = 2;
      delete legacyEntry.lastAttemptAt;
      fs.writeFileSync(filePath, JSON.stringify(legacyEntry), "utf-8");

      const entries = await loadPendingDeliveries(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.lastAttemptAt).toBe(entries[0]?.enqueuedAt);

      const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(persisted.lastAttemptAt).toBe(persisted.enqueuedAt);
    });
  });

  describe("computeBackoffMs", () => {
    it("returns scheduled backoff values and clamps at max retry", () => {
      const cases = [
        { retryCount: 0, expected: 0 },
        { retryCount: 1, expected: 5_000 },
        { retryCount: 2, expected: 25_000 },
        { retryCount: 3, expected: 120_000 },
        { retryCount: 4, expected: 600_000 },
        { retryCount: 5, expected: 600_000 },
      ] as const;

      for (const testCase of cases) {
        expect(computeBackoffMs(testCase.retryCount), String(testCase.retryCount)).toBe(
          testCase.expected,
        );
      }
    });
  });

  describe("isEntryEligibleForRecoveryRetry", () => {
    it("allows first replay after crash for retryCount=0 without lastAttemptAt", () => {
      const now = Date.now();
      const result = isEntryEligibleForRecoveryRetry(
        {
          id: "entry-1",
          channel: "whatsapp",
          to: "+1",
          payloads: [{ text: "a" }],
          enqueuedAt: now,
          retryCount: 0,
        },
        now,
      );
      expect(result).toEqual({ eligible: true });
    });

    it("defers retry entries until backoff window elapses", () => {
      const now = Date.now();
      const result = isEntryEligibleForRecoveryRetry(
        {
          id: "entry-2",
          channel: "whatsapp",
          to: "+1",
          payloads: [{ text: "a" }],
          enqueuedAt: now - 30_000,
          retryCount: 3,
          lastAttemptAt: now,
        },
        now,
      );
      expect(result.eligible).toBe(false);
      if (result.eligible) {
        throw new Error("Expected ineligible retry entry");
      }
      expect(result.remainingBackoffMs).toBeGreaterThan(0);
    });
  });

  describe("recoverPendingDeliveries", () => {
    const baseCfg = {};
    const createLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const enqueueCrashRecoveryEntries = async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);
      await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir);
    };
    const setEntryState = (
      id: string,
      state: { retryCount: number; lastAttemptAt?: number; enqueuedAt?: number },
    ) => {
      const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.retryCount = state.retryCount;
      if (state.lastAttemptAt === undefined) {
        delete entry.lastAttemptAt;
      } else {
        entry.lastAttemptAt = state.lastAttemptAt;
      }
      if (state.enqueuedAt !== undefined) {
        entry.enqueuedAt = state.enqueuedAt;
      }
      fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");
    };
    const runRecovery = async ({
      deliver,
      log = createLog(),
      maxRecoveryMs,
    }: {
      deliver: ReturnType<typeof vi.fn>;
      log?: ReturnType<typeof createLog>;
      maxRecoveryMs?: number;
    }) => {
      const result = await recoverPendingDeliveries({
        deliver: deliver as DeliverFn,
        log,
        cfg: baseCfg,
        stateDir: tmpDir,
        ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
      });
      return { result, log };
    };

    it("recovers entries from a simulated crash", async () => {
      await enqueueCrashRecoveryEntries();
      const deliver = vi.fn().mockResolvedValue([]);
      const { result } = await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(result.recovered).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.skippedMaxRetries).toBe(0);
      expect(result.deferredBackoff).toBe(0);

      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(0);
    });

    it("moves entries that exceeded max retries to failed/", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
        tmpDir,
      );
      setEntryState(id, { retryCount: MAX_RETRIES });

      const deliver = vi.fn();
      const { result } = await runRecovery({ deliver });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.skippedMaxRetries).toBe(1);
      expect(result.deferredBackoff).toBe(0);

      const failedDir = path.join(tmpDir, "delivery-queue", "failed");
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
    });

    it("increments retryCount on failed recovery attempt", async () => {
      await enqueueDelivery({ channel: "slack", to: "#ch", payloads: [{ text: "x" }] }, tmpDir);

      const deliver = vi.fn().mockRejectedValue(new Error("network down"));
      const { result } = await runRecovery({ deliver });

      expect(result.failed).toBe(1);
      expect(result.recovered).toBe(0);

      const entries = await loadPendingDeliveries(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].retryCount).toBe(1);
      expect(entries[0].lastError).toBe("network down");
    });

    it("moves entries to failed/ immediately on permanent delivery errors", async () => {
      const id = await enqueueDelivery(
        { channel: "msteams", to: "user:abc", payloads: [{ text: "hi" }] },
        tmpDir,
      );
      const deliver = vi
        .fn()
        .mockRejectedValue(new Error("No conversation reference found for user:abc"));
      const log = createLog();
      const { result } = await runRecovery({ deliver, log });

      expect(result.failed).toBe(1);
      expect(result.recovered).toBe(0);
      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(0);
      const failedDir = path.join(tmpDir, "delivery-queue", "failed");
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("permanent error"));
    });

    it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);

      const deliver = vi.fn().mockResolvedValue([]);
      await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ skipQueue: true }));
    });

    it("replays stored delivery options during recovery", async () => {
      await enqueueDelivery(
        {
          channel: "whatsapp",
          to: "+1",
          payloads: [{ text: "a" }],
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          mirror: {
            sessionKey: "agent:main:main",
            text: "a",
            mediaUrls: ["https://example.com/a.png"],
          },
        },
        tmpDir,
      );

      const deliver = vi.fn().mockResolvedValue([]);
      await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          mirror: {
            sessionKey: "agent:main:main",
            text: "a",
            mediaUrls: ["https://example.com/a.png"],
          },
        }),
      );
    });

    it("respects maxRecoveryMs time budget", async () => {
      await enqueueCrashRecoveryEntries();
      await enqueueDelivery({ channel: "slack", to: "#c", payloads: [{ text: "c" }] }, tmpDir);

      const deliver = vi.fn().mockResolvedValue([]);
      const { result, log } = await runRecovery({
        deliver,
        maxRecoveryMs: 0,
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.recovered).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skippedMaxRetries).toBe(0);
      expect(result.deferredBackoff).toBe(0);

      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(3);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next restart"));
    });

    it("defers entries until backoff becomes eligible", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
        tmpDir,
      );
      setEntryState(id, { retryCount: 3, lastAttemptAt: Date.now() });

      const deliver = vi.fn().mockResolvedValue([]);
      const { result, log } = await runRecovery({
        deliver,
        maxRecoveryMs: 60_000,
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(result).toEqual({
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 1,
      });

      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(1);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("not ready for retry yet"));
    });

    it("continues past high-backoff entries and recovers ready entries behind them", async () => {
      const now = Date.now();
      const blockedId = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "blocked" }] },
        tmpDir,
      );
      const readyId = await enqueueDelivery(
        { channel: "telegram", to: "2", payloads: [{ text: "ready" }] },
        tmpDir,
      );

      setEntryState(blockedId, { retryCount: 3, lastAttemptAt: now, enqueuedAt: now - 30_000 });
      setEntryState(readyId, { retryCount: 0, enqueuedAt: now - 10_000 });

      const deliver = vi.fn().mockResolvedValue([]);
      const { result } = await runRecovery({ deliver, maxRecoveryMs: 60_000 });

      expect(result).toEqual({
        recovered: 1,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 1,
      });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ channel: "telegram", to: "2", skipQueue: true }),
      );

      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.id).toBe(blockedId);
    });

    it("recovers deferred entries on a later restart once backoff elapsed", async () => {
      vi.useFakeTimers();
      const start = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(start);

      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "later" }] },
        tmpDir,
      );
      setEntryState(id, { retryCount: 3, lastAttemptAt: start.getTime() });

      const firstDeliver = vi.fn().mockResolvedValue([]);
      const firstRun = await runRecovery({ deliver: firstDeliver, maxRecoveryMs: 60_000 });
      expect(firstRun.result).toEqual({
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 1,
      });
      expect(firstDeliver).not.toHaveBeenCalled();

      vi.setSystemTime(new Date(start.getTime() + 600_000 + 1));
      const secondDeliver = vi.fn().mockResolvedValue([]);
      const secondRun = await runRecovery({ deliver: secondDeliver, maxRecoveryMs: 60_000 });
      expect(secondRun.result).toEqual({
        recovered: 1,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(secondDeliver).toHaveBeenCalledTimes(1);

      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(0);

      vi.useRealTimers();
    });

    it("returns zeros when queue is empty", async () => {
      const deliver = vi.fn();
      const { result } = await runRecovery({ deliver });

      expect(result).toEqual({
        recovered: 0,
        failed: 0,
        skippedMaxRetries: 0,
        deferredBackoff: 0,
      });
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});
