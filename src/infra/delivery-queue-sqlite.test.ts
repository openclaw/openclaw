// Validates SQLite delivery queue inflate guards against corrupted entry_json.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  deleteDeliveryQueueEntry,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery-queue-sqlite corrupt JSON resilience", () => {
  let stateDir: string;
  let tmpDir: string;
  const QUEUE = "test-q";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-case-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertCorruptRow(id: string, json: string) {
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    db.prepare(
      `INSERT INTO delivery_queue_entries
         (queue_name, id, status, entry_kind, session_key, channel, target, account_id,
          retry_count, last_attempt_at, last_error, platform_send_started_at, recovery_state,
          entry_json, enqueued_at, updated_at, failed_at)
       VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL,
               0, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)`,
    ).run(QUEUE, id, json, Date.now(), Date.now());
    db.close();
  }

  function enqueueValid(id: string) {
    upsertDeliveryQueueEntry({
      queueName: QUEUE,
      entry: { id, enqueuedAt: Date.now(), retryCount: 0 },
      stateDir,
    });
  }

  describe("loadDeliveryQueueEntry", () => {
    it("returns null for a row with corrupted entry_json", () => {
      insertCorruptRow("bad-1", "{corrupt: true, >>>NOT JSON<<<");
      expect(loadDeliveryQueueEntry(QUEUE, "bad-1", stateDir)).toBeNull();
    });

    it("returns the entry for valid JSON", () => {
      enqueueValid("good-1");
      const result = loadDeliveryQueueEntry(QUEUE, "good-1", stateDir);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("good-1");
    });

    it("returns null for a nonexistent entry", () => {
      expect(loadDeliveryQueueEntry(QUEUE, "nonexistent", stateDir)).toBeNull();
    });
  });

  describe("loadDeliveryQueueEntries", () => {
    it("skips corrupt rows, returns only valid entries", () => {
      enqueueValid("valid-a");
      insertCorruptRow("bad-x", "{{{broken");
      enqueueValid("valid-b");

      const entries = loadDeliveryQueueEntries(QUEUE, stateDir);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.id).sort()).toEqual(["valid-a", "valid-b"]);
    });

    it("returns empty array when all rows are corrupt", () => {
      insertCorruptRow("bad-1", "not json");
      insertCorruptRow("bad-2", "{also broken");

      expect(loadDeliveryQueueEntries(QUEUE, stateDir)).toEqual([]);
    });

    it("returns all entries when all rows are valid", () => {
      enqueueValid("v1");
      enqueueValid("v2");
      enqueueValid("v3");

      expect(loadDeliveryQueueEntries(QUEUE, stateDir)).toHaveLength(3);
    });
  });

  describe("updateDeliveryQueueEntry with corrupt row", () => {
    it("throws ENOENT (unrecoverable corrupt JSON)", () => {
      insertCorruptRow("bad-update", "{corrupt");

      expect(() => updateDeliveryQueueEntry(QUEUE, "bad-update", stateDir, (e) => e)).toThrow(
        /No pending test-q delivery queue entry bad-update/,
      );
    });
  });

  describe("moveDeliveryQueueEntryToFailed with corrupt row", () => {
    it("throws ENOENT (unrecoverable corrupt JSON)", () => {
      insertCorruptRow("bad-move", "{corrupt");

      expect(() => moveDeliveryQueueEntryToFailed(QUEUE, "bad-move", stateDir)).toThrow(
        /No pending test-q delivery queue entry bad-move/,
      );
    });
  });

  describe("valid entry round-trips", () => {
    it("upsert then load is identity", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "rt-1", enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      const loaded = loadDeliveryQueueEntry(QUEUE, "rt-1", stateDir);
      expect(loaded).toMatchObject({ id: "rt-1", enqueuedAt: 1000, retryCount: 0 });
    });

    it("update increments retry count", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "rt-2", enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      updateDeliveryQueueEntry(QUEUE, "rt-2", stateDir, (entry) => ({
        ...entry,
        retryCount: entry.retryCount + 1,
        lastError: "timeout",
      }));

      expect(loadDeliveryQueueEntry(QUEUE, "rt-2", stateDir)).toMatchObject({
        id: "rt-2",
        retryCount: 1,
        lastError: "timeout",
      });
    });

    it("delete removes the entry", () => {
      upsertDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id: "rt-3", enqueuedAt: 1000, retryCount: 0 },
        stateDir,
      });

      deleteDeliveryQueueEntry(QUEUE, "rt-3", stateDir);
      expect(loadDeliveryQueueEntry(QUEUE, "rt-3", stateDir)).toBeNull();
    });
  });
});
