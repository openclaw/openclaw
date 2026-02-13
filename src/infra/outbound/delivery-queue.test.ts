import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackDelivery,
  computeBackoffMs,
  enqueueDelivery,
  failDelivery,
  loadPendingDeliveries,
  MAX_RETRIES,
  moveToFailed,
  recoverPendingDeliveries,
} from "./delivery-queue.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dq-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

    // Entry file exists after enqueue.
    const queueDir = path.join(tmpDir, "delivery-queue");
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${id}.json`);

    // Entry contents are correct.
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

    // Ack removes the file.
    await ackDelivery(id, tmpDir);
    const remaining = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(0);
  });

  it("ack is idempotent (no error on missing file)", async () => {
    await expect(ackDelivery("nonexistent-id", tmpDir)).resolves.toBeUndefined();
  });
});

describe("failDelivery", () => {
  it("increments retryCount and sets lastError", async () => {
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
});

describe("computeBackoffMs", () => {
  it("returns 0 for retryCount 0", () => {
    expect(computeBackoffMs(0)).toBe(0);
  });

  it("returns correct backoff for each retry", () => {
    expect(computeBackoffMs(1)).toBe(5_000);
    expect(computeBackoffMs(2)).toBe(25_000);
    expect(computeBackoffMs(3)).toBe(120_000);
    expect(computeBackoffMs(4)).toBe(600_000);
    // Beyond defined schedule — clamps to last value.
    expect(computeBackoffMs(5)).toBe(600_000);
  });
});

describe("recoverPendingDeliveries", () => {
  const noopDelay = async () => {};
  const baseCfg = {};

  it("recovers entries from a simulated crash", async () => {
    // Manually create two queue entries as if gateway crashed before delivery.
    await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);
    await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir);

    const deliver = vi.fn().mockResolvedValue([]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Queue should be empty after recovery.
    const remaining = await loadPendingDeliveries(tmpDir);
    expect(remaining).toHaveLength(0);
  });

  it("moves entries that exceeded max retries to failed/", async () => {
    // Create an entry and manually set retryCount to MAX_RETRIES.
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
      tmpDir,
    );
    const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
    const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    entry.retryCount = MAX_RETRIES;
    fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");

    const deliver = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);

    // Entry should be in failed/ directory.
    const failedDir = path.join(tmpDir, "delivery-queue", "failed");
    expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
  });

  it("increments retryCount on failed recovery attempt", async () => {
    await enqueueDelivery({ channel: "slack", to: "#ch", payloads: [{ text: "x" }] }, tmpDir);

    const deliver = vi.fn().mockRejectedValue(new Error("network down"));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
    });

    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(0);

    // Entry should still be in queue with incremented retryCount.
    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].retryCount).toBe(1);
    expect(entries[0].lastError).toBe("network down");
  });

  it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
    await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);

    const deliver = vi.fn().mockResolvedValue([]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
    });

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
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
    });

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
    await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);
    await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir);
    await enqueueDelivery({ channel: "slack", to: "#c", payloads: [{ text: "c" }] }, tmpDir);

    const deliver = vi.fn().mockResolvedValue([]);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
      maxRecoveryMs: 0, // Immediate timeout — no entries should be processed.
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // All entries should still be in the queue.
    const remaining = await loadPendingDeliveries(tmpDir);
    expect(remaining).toHaveLength(3);

    // Should have logged a warning about deferred entries.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next restart"));
  });

  it("defers entries when backoff exceeds the recovery budget", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
      tmpDir,
    );
    const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
    const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    entry.retryCount = 3;
    fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");

    const deliver = vi.fn().mockResolvedValue([]);
    const delay = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay,
      maxRecoveryMs: 1000,
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });

    const remaining = await loadPendingDeliveries(tmpDir);
    expect(remaining).toHaveLength(1);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next restart"));
  });

  it("returns zeros when queue is empty", async () => {
    const deliver = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg: baseCfg,
      stateDir: tmpDir,
      delay: noopDelay,
    });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });
});
