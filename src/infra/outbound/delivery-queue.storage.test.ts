import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  loadPendingDeliveries,
  moveToFailed,
} from "./delivery-queue.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("delivery-queue storage", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

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
        tmpDir(),
      );

      const queueDir = path.join(tmpDir(), "delivery-queue");
      const files = fs.readdirSync(queueDir).filter((file) => file.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${id}.json`);

      const entry = readQueuedEntry(tmpDir(), id);
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

      await ackDelivery(id, tmpDir());
      expect(fs.readdirSync(queueDir).filter((file) => file.endsWith(".json"))).toHaveLength(0);
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir())).resolves.toBeUndefined();
    });

    it("ack cleans up leftover .delivered marker when .json is already gone", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "stale-marker" }] },
        tmpDir(),
      );
      const queueDir = path.join(tmpDir(), "delivery-queue");

      fs.renameSync(path.join(queueDir, `${id}.json`), path.join(queueDir, `${id}.delivered`));
      await expect(ackDelivery(id, tmpDir())).resolves.toBeUndefined();

      expect(fs.existsSync(path.join(queueDir, `${id}.delivered`))).toBe(false);
    });

    it("ack removes .delivered marker so recovery does not replay", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "ack-test" }] },
        tmpDir(),
      );
      const queueDir = path.join(tmpDir(), "delivery-queue");

      await ackDelivery(id, tmpDir());

      expect(fs.existsSync(path.join(queueDir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(queueDir, `${id}.delivered`))).toBe(false);
    });

    it("loadPendingDeliveries cleans up stale .delivered markers without replaying", async () => {
      const id = await enqueueDelivery(
        { channel: "telegram", to: "99", payloads: [{ text: "stale" }] },
        tmpDir(),
      );
      const queueDir = path.join(tmpDir(), "delivery-queue");

      fs.renameSync(path.join(queueDir, `${id}.json`), path.join(queueDir, `${id}.delivered`));

      const entries = await loadPendingDeliveries(tmpDir());

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
        tmpDir(),
      );

      await failDelivery(id, "connection refused", tmpDir());

      const entry = readQueuedEntry(tmpDir(), id);
      expect(entry.retryCount).toBe(1);
      expect(typeof entry.lastAttemptAt).toBe("number");
      expect((entry.lastAttemptAt as number) > 0).toBe(true);
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
        tmpDir(),
      );

      await moveToFailed(id, tmpDir());

      const queueDir = path.join(tmpDir(), "delivery-queue");
      const failedDir = path.join(queueDir, "failed");
      expect(fs.existsSync(path.join(queueDir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array when queue directory does not exist", async () => {
      expect(await loadPendingDeliveries(path.join(tmpDir(), "no-such-dir"))).toEqual([]);
    });

    it("loads multiple entries", async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir());
      await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir());

      expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
    });

    it("backfills lastAttemptAt for legacy retry entries during load", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "legacy" }] },
        tmpDir(),
      );
      const filePath = path.join(tmpDir(), "delivery-queue", `${id}.json`);
      const legacyEntry = readQueuedEntry(tmpDir(), id);
      legacyEntry.retryCount = 2;
      delete legacyEntry.lastAttemptAt;
      fs.writeFileSync(filePath, JSON.stringify(legacyEntry), "utf-8");

      const entries = await loadPendingDeliveries(tmpDir());
      expect(entries).toHaveLength(1);
      expect(entries[0]?.lastAttemptAt).toBe(entries[0]?.enqueuedAt);

      const persisted = readQueuedEntry(tmpDir(), id);
      expect(persisted.lastAttemptAt).toBe(persisted.enqueuedAt);
    });
  });
});
