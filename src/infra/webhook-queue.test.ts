import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dequeueWebhook, enqueueWebhook, replayPendingWebhooks } from "./webhook-queue.js";

describe("webhook-queue", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "webhook-queue-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  });

  const payload = { update_id: 100, message: { text: "hello" } };

  it("enqueue writes a file and dequeue removes it", async () => {
    await enqueueWebhook("telegram", "100", payload, stateDir);

    const queueDir = path.join(stateDir, "webhook-queue");
    const files = await fs.promises.readdir(queueDir);
    expect(files).toEqual(["telegram_100.json"]);

    const content = JSON.parse(await fs.promises.readFile(path.join(queueDir, files[0]), "utf-8"));
    expect(content.channelId).toBe("telegram");
    expect(content.deduplicationId).toBe("100");
    expect(content.payload).toEqual(payload);
    expect(typeof content.enqueuedAt).toBe("number");

    await dequeueWebhook("telegram", "100", stateDir);
    const remaining = await fs.promises.readdir(queueDir);
    expect(remaining).toEqual([]);
  });

  it("dequeue is idempotent (no error on missing file)", async () => {
    await expect(dequeueWebhook("telegram", "999", stateDir)).resolves.toBeUndefined();
  });

  it("replayPendingWebhooks returns entries sorted by enqueue time", async () => {
    const now = Date.now();
    await enqueueWebhook("telegram", "1", { update_id: 1 }, stateDir);
    // Ensure distinct timestamps.
    const queueDir = path.join(stateDir, "webhook-queue");
    const file1 = path.join(queueDir, "telegram_1.json");
    const entry1 = JSON.parse(await fs.promises.readFile(file1, "utf-8"));
    entry1.enqueuedAt = now - 2000;
    await fs.promises.writeFile(file1, JSON.stringify(entry1));

    await enqueueWebhook("telegram", "2", { update_id: 2 }, stateDir);
    const file2 = path.join(queueDir, "telegram_2.json");
    const entry2 = JSON.parse(await fs.promises.readFile(file2, "utf-8"));
    entry2.enqueuedAt = now - 5000; // Earlier timestamp.
    await fs.promises.writeFile(file2, JSON.stringify(entry2));

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toHaveLength(2);
    expect(pending[0].deduplicationId).toBe("2"); // Earlier first.
    expect(pending[1].deduplicationId).toBe("1");
  });

  it("replayPendingWebhooks deduplicates by deduplicationId", async () => {
    await enqueueWebhook("telegram", "100", { update_id: 100, v: 1 }, stateDir);
    // Write a second file with the same deduplicationId but different channelId
    // to test dedup across channels — only the earliest should survive.
    const queueDir = path.join(stateDir, "webhook-queue");
    const dup: Record<string, unknown> = {
      channelId: "other",
      deduplicationId: "100",
      enqueuedAt: Date.now() + 1000,
      payload: { update_id: 100, v: 2 },
    };
    await fs.promises.writeFile(path.join(queueDir, "other_100.json"), JSON.stringify(dup));

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as Record<string, unknown>).v).toBe(1);
  });

  it("replayPendingWebhooks filters by channelId when specified", async () => {
    await enqueueWebhook("telegram", "1", { update_id: 1 }, stateDir);
    await enqueueWebhook("whatsapp", "2", { id: "abc" }, stateDir);

    const telegramOnly = await replayPendingWebhooks("telegram", stateDir);
    expect(telegramOnly).toHaveLength(1);
    expect(telegramOnly[0].channelId).toBe("telegram");
  });

  it("replayPendingWebhooks cleans up entries older than 1 hour", async () => {
    await enqueueWebhook("telegram", "old", { update_id: 1 }, stateDir);
    const queueDir = path.join(stateDir, "webhook-queue");
    const oldFile = path.join(queueDir, "telegram_old.json");
    const entry = JSON.parse(await fs.promises.readFile(oldFile, "utf-8"));
    entry.enqueuedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago.
    await fs.promises.writeFile(oldFile, JSON.stringify(entry));

    await enqueueWebhook("telegram", "fresh", { update_id: 2 }, stateDir);

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].deduplicationId).toBe("fresh");

    // Old file should be deleted.
    await expect(fs.promises.access(oldFile)).rejects.toThrow();
  });

  it("replayPendingWebhooks returns empty array when queue dir does not exist", async () => {
    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toEqual([]);
  });

  it("replayPendingWebhooks skips malformed files", async () => {
    const queueDir = path.join(stateDir, "webhook-queue");
    await fs.promises.mkdir(queueDir, { recursive: true });
    await fs.promises.writeFile(path.join(queueDir, "bad-file.json"), "not json{{{");
    await enqueueWebhook("telegram", "1", { update_id: 1 }, stateDir);

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].deduplicationId).toBe("1");
  });

  it("handles many queued messages replayed in order", async () => {
    const now = Date.now();
    const queueDir = path.join(stateDir, "webhook-queue");
    await fs.promises.mkdir(queueDir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      const entry = {
        channelId: "telegram",
        deduplicationId: String(i),
        enqueuedAt: now - (50 - i) * 100, // Reverse ID order to test sorting.
        payload: { update_id: i },
      };
      await fs.promises.writeFile(path.join(queueDir, `telegram_${i}.json`), JSON.stringify(entry));
    }

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toHaveLength(50);
    // Sorted by enqueuedAt ascending: update_id 0 has earliest enqueuedAt.
    expect(pending[0].deduplicationId).toBe("0");
    expect(pending[49].deduplicationId).toBe("49");
  });

  it("replayPendingWebhooks breaks timestamp ties by deduplicationId", async () => {
    const now = Date.now();
    const queueDir = path.join(stateDir, "webhook-queue");
    await fs.promises.mkdir(queueDir, { recursive: true });
    // Three entries with the same timestamp — order must be deterministic.
    for (const id of ["300", "100", "200"]) {
      const entry = { channelId: "telegram", deduplicationId: id, enqueuedAt: now, payload: {} };
      await fs.promises.writeFile(
        path.join(queueDir, `telegram_${id}.json`),
        JSON.stringify(entry),
      );
    }

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending.map((e) => e.deduplicationId)).toEqual(["100", "200", "300"]);
  });

  it("replayPendingWebhooks cleans up orphaned .tmp files", async () => {
    const queueDir = path.join(stateDir, "webhook-queue");
    await fs.promises.mkdir(queueDir, { recursive: true });
    // Simulate an orphaned temp file from an interrupted write.
    await fs.promises.writeFile(path.join(queueDir, "telegram_42.json.12345.tmp"), "partial");
    await enqueueWebhook("telegram", "1", { update_id: 1 }, stateDir);

    const pending = await replayPendingWebhooks(undefined, stateDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].deduplicationId).toBe("1");

    // Orphaned tmp file should be deleted.
    const remaining = await fs.promises.readdir(queueDir);
    expect(remaining.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("enqueue overwrites existing entry with same deduplicationId", async () => {
    await enqueueWebhook("telegram", "100", { update_id: 100, v: 1 }, stateDir);
    await enqueueWebhook("telegram", "100", { update_id: 100, v: 2 }, stateDir);

    const queueDir = path.join(stateDir, "webhook-queue");
    const files = await fs.promises.readdir(queueDir);
    expect(files).toHaveLength(1);

    const content = JSON.parse(await fs.promises.readFile(path.join(queueDir, files[0]), "utf-8"));
    expect(content.payload.v).toBe(2);
  });
});
