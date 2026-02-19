import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  enqueueDelivery,
  ackDelivery,
  failDelivery,
  loadPendingDeliveries,
  recoverPendingDeliveries,
  isPermanentError,
  MAX_AGE_MS,
} from "./delivery-queue.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dq-test-"));
}

function cleanTmpDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("delivery-queue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanTmpDir(tmpDir);
  });

  test("enqueue + load + ack cycle", async () => {
    const id = await enqueueDelivery(
      {
        channel: "telegram",
        to: "123",
        payloads: [{ text: "hello" }],
      },
      tmpDir,
    );
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id);

    await ackDelivery(id, tmpDir);
    const after = await loadPendingDeliveries(tmpDir);
    expect(after).toHaveLength(0);
  });

  test("failDelivery increments retryCount", async () => {
    const id = await enqueueDelivery(
      {
        channel: "telegram",
        to: "123",
        payloads: [{ text: "hello" }],
      },
      tmpDir,
    );
    await failDelivery(id, "timeout", tmpDir);
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending[0].retryCount).toBe(1);
    expect(pending[0].lastError).toBe("timeout");
  });

  describe("isPermanentError", () => {
    test("detects message too long", () => {
      expect(
        isPermanentError("Call to 'sendMessage' failed! (400: Bad Request: message is too long)"),
      ).toBe(true);
    });

    test("detects bot token missing", () => {
      expect(
        isPermanentError(
          'Telegram bot token missing for account "default" (set channels.telegram.accounts.default.botToken)',
        ),
      ).toBe(true);
    });

    test("detects blocked by user", () => {
      expect(isPermanentError("Forbidden: bot was blocked by the user")).toBe(true);
    });

    test("detects chat write forbidden", () => {
      expect(isPermanentError("CHAT_WRITE_FORBIDDEN")).toBe(true);
    });

    test("returns false for transient errors", () => {
      expect(isPermanentError("ETIMEDOUT")).toBe(false);
      expect(isPermanentError("rate limit exceeded")).toBe(false);
      expect(isPermanentError("500 Internal Server Error")).toBe(false);
    });
  });

  test("failDelivery moves permanent errors to failed/", async () => {
    const id = await enqueueDelivery(
      {
        channel: "telegram",
        to: "123",
        payloads: [{ text: "x".repeat(5000) }],
      },
      tmpDir,
    );
    await failDelivery(id, "message is too long", tmpDir);
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
    // Should be in failed/
    const failedDir = path.join(tmpDir, "delivery-queue", "failed");
    const failedFiles = fs.readdirSync(failedDir).filter((f) => f.endsWith(".json"));
    expect(failedFiles).toHaveLength(1);
  });

  describe("recoverPendingDeliveries", () => {
    const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const noopDelay = async () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const minCfg = {} as any;

    test("skips entries older than MAX_AGE_MS", async () => {
      const id = await enqueueDelivery(
        {
          channel: "telegram",
          to: "123",
          payloads: [{ text: "stale" }],
        },
        tmpDir,
      );
      // Backdate the entry
      const queueDir = path.join(tmpDir, "delivery-queue");
      const filePath = path.join(queueDir, `${id}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.enqueuedAt = Date.now() - MAX_AGE_MS - 60_000; // 1 min past max age
      fs.writeFileSync(filePath, JSON.stringify(entry));

      const result = await recoverPendingDeliveries({
        deliver: async () => {
          throw new Error("should not be called");
        },
        log: noopLogger,
        cfg: minCfg,
        stateDir: tmpDir,
        delay: noopDelay,
      });

      expect(result.skipped).toBe(1);
      expect(result.recovered).toBe(0);
    });

    test("skips entries with permanent errors", async () => {
      const id = await enqueueDelivery(
        {
          channel: "telegram",
          to: "123",
          payloads: [{ text: "x".repeat(5000) }],
        },
        tmpDir,
      );
      // Set a permanent error
      const queueDir = path.join(tmpDir, "delivery-queue");
      const filePath = path.join(queueDir, `${id}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.lastError = "message is too long";
      entry.retryCount = 1;
      fs.writeFileSync(filePath, JSON.stringify(entry));

      const result = await recoverPendingDeliveries({
        deliver: async () => {
          throw new Error("should not be called");
        },
        log: noopLogger,
        cfg: minCfg,
        stateDir: tmpDir,
        delay: noopDelay,
      });

      expect(result.skipped).toBe(1);
      expect(result.recovered).toBe(0);
    });

    test("recovers valid entries", async () => {
      await enqueueDelivery(
        {
          channel: "telegram",
          to: "123",
          payloads: [{ text: "hello" }],
        },
        tmpDir,
      );

      const result = await recoverPendingDeliveries({
        deliver: async () => {},
        log: noopLogger,
        cfg: minCfg,
        stateDir: tmpDir,
        delay: noopDelay,
      });

      expect(result.recovered).toBe(1);
    });
  });
});
