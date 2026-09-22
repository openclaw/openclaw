import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { upsertDeliveryQueueEntry } from "./delivery-queue-sqlite.js";
import { installDeliveryQueueTmpDirHooks } from "./outbound/delivery-queue.test-helpers.js";
import {
  createLegacyStateMigrationStepReceipt,
  throwIfDoctorStateMigrationRefused,
} from "./state-migrations.messages.js";
import { migrateLegacyDeliveryQueues } from "./state-migrations.storage.js";

const NOW = Date.UTC(2026, 8, 12, 12);
const AGE_LIMIT = 72 * 60 * 60_000;
const QUEUES = [
  { dirName: "delivery-queue", queueName: "outbound" },
  { dirName: "session-delivery-queue", queueName: "session" },
] as const;
type Queue = (typeof QUEUES)[number];

function legacyEntry(queue: Queue, id: string, enqueuedAt: unknown = NOW - 1) {
  return {
    id,
    enqueuedAt,
    retryCount: 0,
    ...(queue.queueName === "outbound"
      ? { channel: "matrix", to: "!room:example", payloads: [{ text: id }] }
      : { kind: "agentTurn", sessionKey: "agent:main:main", message: id, messageId: id }),
  };
}

describe("legacy delivery queue file retention", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();
  let migrationTime = NOW;
  beforeEach(() => {
    migrationTime = NOW;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function migrate() {
    const clock = vi.spyOn(Date, "now").mockReturnValue(migrationTime);
    try {
      return await migrateLegacyDeliveryQueues({ stateDir: tmpDir() });
    } finally {
      clock.mockRestore();
    }
  }

  function writeEntry(queue: Queue, name: string, entry: unknown) {
    const sourcePath = path.join(tmpDir(), queue.dirName, name);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(entry, null, 2) + "\n");
    fs.writeFileSync(sourcePath, bytes);
    return { sourcePath, bytes };
  }
  function database() {
    return openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: tmpDir() } }).db;
  }
  function receipts() {
    return database()
      .prepare(
        "SELECT source_path, source_sha256, source_size_bytes, removed_source, report_json FROM migration_sources WHERE migration_kind = 'delivery-queues' ORDER BY source_path",
      )
      .all();
  }
  function expectArchived(source: { sourcePath: string; bytes: Buffer }, suffix = ".migrated") {
    expect(fs.existsSync(source.sourcePath)).toBe(false);
    expect(fs.readFileSync(source.sourcePath + suffix)).toEqual(source.bytes);
    if (process.platform !== "win32") {
      expect(fs.statSync(source.sourcePath + suffix).mode & 0o777).toBe(0o600);
    }
  }

  it.each(QUEUES)(
    "$queueName: uses enqueue age and retains unverified timestamps without runnable rows",
    async (queue) => {
      const invalidTimes = [undefined, null, "123", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NOW + 1];
      const originals = invalidTimes.map((time, index) =>
        writeEntry(queue, "invalid-" + index + ".json", {
          ...legacyEntry(queue, "invalid-" + index),
          enqueuedAt: time,
        }),
      );
      const retried = writeEntry(queue, "retried.json", {
        ...legacyEntry(queue, "retried", NOW - AGE_LIMIT),
        retryCount: 1,
        lastAttemptAt: NOW - 1,
      });
      fs.utimesSync(retried.sourcePath, new Date(NOW), new Date(NOW));
      const result = await migrate();
      expect(result.warningDisposition).toBe("recoverable");
      expect(
        result.warnings.filter((warning) => warning.includes("unverified enqueue time")),
      ).toHaveLength(invalidTimes.length);
      expect(result.warnings.join("\n")).toContain("at least 72 hours old");
      for (const source of [...originals, retried]) {
        expectArchived(source);
      }
      expect(database().prepare("SELECT count(*) AS n FROM delivery_queue_entries").get()).toEqual({
        n: 0,
      });
      expect(receipts()).toHaveLength(8);
    },
  );

  it.each(QUEUES)(
    "$queueName: keeps failed semantics, delivered twins, and complete original bytes",
    async (queue) => {
      const payload = "private original 🦞\u0000" + "x".repeat(100_000) + "END";
      const stale = writeEntry(queue, "stale.json", {
        ...legacyEntry(queue, "stale", NOW - AGE_LIMIT),
        message: payload,
        payloads: [{ text: payload }],
      });
      const failed = writeEntry(queue, "failed/failed.json", {
        ...legacyEntry(queue, "failed", NOW - AGE_LIMIT),
        retainOnFailure: true,
        retryCount: 3,
      });
      const ordinaryFailed = writeEntry(
        queue,
        "failed/ordinary.json",
        legacyEntry(queue, "ordinary", NOW - AGE_LIMIT),
      );
      const twin = writeEntry(queue, "done.json", legacyEntry(queue, "done"));
      const marker = writeEntry(queue, "done.delivered", legacyEntry(queue, "done"));
      await migrate();
      for (const source of [stale, failed, ordinaryFailed, twin, marker]) {
        expectArchived(source);
      }
      expect(
        database()
          .prepare("SELECT id, status, entry_json FROM delivery_queue_entries WHERE queue_name = ?")
          .all(queue.queueName),
      ).toEqual([
        { id: "failed", status: "failed", entry_json: expect.not.stringContaining("payloads") },
      ]);
      const sourceReceipt = receipts().find((row) => row.source_path === stale.sourcePath);
      expect(sourceReceipt).toMatchObject({
        source_size_bytes: stale.bytes.length,
        removed_source: 1,
      });
    },
  );

  it.each(QUEUES)(
    "$queueName: retains canonical conflicts, equal duplicate IDs, and unknown files",
    async (queue) => {
      const canonical = { ...legacyEntry(queue, "conflict"), enqueuedAt: NOW - 1, retryCount: 2 };
      upsertDeliveryQueueEntry({
        queueName: queue.queueName,
        entry: canonical,
        stateDir: tmpDir(),
      });
      const conflicting = writeEntry(queue, "conflict.json", legacyEntry(queue, "conflict"));
      const first = writeEntry(queue, "one.json", legacyEntry(queue, "equal"));
      const second = writeEntry(queue, "two.json", legacyEntry(queue, "equal"));
      const unknownPath = path.join(tmpDir(), queue.dirName, "operator-notes.txt");
      fs.writeFileSync(unknownPath, "keep");
      const result = await migrate();
      expect(result.warningDisposition).toBeUndefined();
      expect(result.warnings.join("\n")).toContain("already existed in shared state: conflict");
      expect(fs.readFileSync(conflicting.sourcePath)).toEqual(conflicting.bytes);
      expectArchived(first);
      expectArchived(second);
      expect(fs.readFileSync(unknownPath, "utf8")).toBe("keep");
      expect(
        database()
          .prepare(
            "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = ? AND id = 'conflict'",
          )
          .get(queue.queueName),
      ).toEqual({ retry_count: 2 });
      expect(
        database()
          .prepare(
            "SELECT count(*) AS n FROM delivery_queue_entries WHERE queue_name = ? AND id = 'equal'",
          )
          .get(queue.queueName),
      ).toEqual({ n: 1 });
      expect((await migrate()).warnings).toEqual(result.warnings);
      expect(receipts()).toHaveLength(2);
    },
  );

  it.each(QUEUES)(
    "$queueName: retries archive failure after queue consumption without recreating work",
    async (queue) => {
      const source = writeEntry(queue, "fresh.json", legacyEntry(queue, "fresh"));
      const stale = writeEntry(queue, "old.json", legacyEntry(queue, "old", NOW - AGE_LIMIT));
      const rename = fs.renameSync;
      const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (from === source.sourcePath || from === stale.sourcePath) {
          throw new Error("archive unavailable");
        }
        return rename(from, to);
      });
      const result = await migrate();
      expect(result.warningDisposition).toBe("recoverable");
      expect(receipts().every((row) => row.removed_source === 0)).toBe(true);
      expect(fs.readFileSync(stale.sourcePath)).toEqual(stale.bytes);
      database()
        .prepare("DELETE FROM delivery_queue_entries WHERE queue_name = ? AND id = 'fresh'")
        .run(queue.queueName);
      fault.mockRestore();
      migrationTime = NOW + AGE_LIMIT;
      const resumed = await migrate();
      expect(resumed.warnings).toHaveLength(1);
      expect(resumed.warnings[0]).toContain("old.json");
      expect(database().prepare("SELECT count(*) AS n FROM delivery_queue_entries").get()).toEqual({
        n: 0,
      });
      expectArchived(source);
      expectArchived(stale);
      expect(receipts().every((row) => row.removed_source === 1)).toBe(true);
      fs.writeFileSync(stale.sourcePath, stale.bytes);
      await migrate();
      expect(fs.readdirSync(path.dirname(stale.sourcePath)).toSorted()).toEqual([
        "fresh.json.migrated",
        "old.json.migrated",
      ]);
      expect(receipts()).toHaveLength(2);
    },
  );

  it.each(QUEUES)(
    "$queueName: preserves archive collisions without repeat copies",
    async (queue) => {
      const source = writeEntry(queue, "old.json", legacyEntry(queue, "old", NOW - AGE_LIMIT));
      fs.writeFileSync(source.sourcePath + ".migrated", "older backup");
      const result = await migrate();
      expect(result.warnings.join("\n")).toContain(source.sourcePath + ".migrated.2");
      expectArchived(source, ".migrated.2");
      fs.writeFileSync(source.sourcePath, source.bytes);
      await migrate();
      expectArchived(source, ".migrated.2");
      expect(fs.existsSync(source.sourcePath + ".migrated.3")).toBe(false);
      expect(fs.readFileSync(source.sourcePath + ".migrated", "utf8")).toBe("older backup");
    },
  );

  it("rolls back queue writes and receipts together on database failure", async () => {
    const queue = QUEUES[0];
    const source = writeEntry(queue, "fresh.json", legacyEntry(queue, "fresh"));
    const db = database();
    db.exec(
      "CREATE TRIGGER reject_queue_receipt BEFORE INSERT ON migration_sources BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
    );
    const result = await migrate();
    expect(result.warningDisposition).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("injected receipt failure");
    expect(db.prepare("SELECT count(*) AS n FROM delivery_queue_entries").get()).toEqual({ n: 0 });
    expect(receipts()).toEqual([]);
    expect(fs.readFileSync(source.sourcePath)).toEqual(source.bytes);
    db.exec("DROP TRIGGER reject_queue_receipt");
    await migrate();
    expect(db.prepare("SELECT id FROM delivery_queue_entries").all()).toEqual([{ id: "fresh" }]);
  });
  it.each(
    QUEUES.flatMap((queue) => [
      { ...queue, markerId: "done", canonicalId: "done" },
      { ...queue, markerId: "one", canonicalId: "equal" },
    ]),
  )(
    "$queueName: keeps $markerId delivered evidence until malformed $canonicalId twin is repaired",
    async (queue) => {
      const source = writeEntry(
        queue,
        `${queue.canonicalId}.json`,
        legacyEntry(queue, queue.canonicalId),
      );
      fs.writeFileSync(source.sourcePath, "{broken");
      const marker = writeEntry(queue, `${queue.markerId}.delivered`, { id: queue.canonicalId });
      const first = await migrate();
      expect(first.warningDisposition).toBeUndefined();
      expect(fs.existsSync(marker.sourcePath)).toBe(true);
      fs.writeFileSync(source.sourcePath, source.bytes);
      const second = await migrate();
      expect(second.warnings).toEqual([]);
      expect(database().prepare("SELECT count(*) AS n FROM delivery_queue_entries").get()).toEqual({
        n: 0,
      });
      expectArchived(source);
      expectArchived(marker);
    },
  );

  it.each(
    QUEUES.flatMap((queue) =>
      ["opaque", "canonical"].flatMap((marker) => [
        { ...queue, marker, malformed: "{broken" },
        { ...queue, marker, malformed: '{"id":"equal",' },
      ]),
    ),
  )(
    "$queueName: does not replay a delivered ID with $marker marker after repairing duplicate $malformed",
    async (queue) => {
      const first = writeEntry(queue, "one.json", legacyEntry(queue, "equal"));
      const second = writeEntry(queue, "two.json", legacyEntry(queue, "equal"));
      fs.writeFileSync(second.sourcePath, queue.malformed);
      const marker = writeEntry(
        queue,
        "one.delivered",
        queue.marker === "opaque" ? "acknowledged" : { id: "equal" },
      );

      const result = await migrate();
      expect(result.warnings.join("\n")).toContain("Left malformed");
      expect.soft(fs.existsSync(first.sourcePath)).toBe(true);
      expect(fs.readFileSync(second.sourcePath, "utf8")).toBe(queue.malformed);
      expect.soft(fs.existsSync(marker.sourcePath)).toBe(true);

      fs.writeFileSync(second.sourcePath, second.bytes);
      expect((await migrate()).warnings).toEqual([]);
      expect(database().prepare("SELECT count(*) AS n FROM delivery_queue_entries").get()).toEqual({
        n: 0,
      });
      expectArchived(first);
      expectArchived(second);
      expectArchived(marker);
    },
  );

  it.each(QUEUES)(
    "$queueName: preserves archives in backups and records nonblocking Doctor results",
    async (queue) => {
      const source = writeEntry(queue, "old.json", legacyEntry(queue, "old", NOW - AGE_LIMIT));
      const result = await migrate();
      const receipt = createLegacyStateMigrationStepReceipt(
        {
          id: "delivery-queues",
          phase: "shared",
          source: [],
          target: [],
          requiredness: "required",
          reversibility: "checkpoint-required",
        },
        result,
      );
      expect(receipt.outcome).toBe("warning");
      expect(() => throwIfDoctorStateMigrationRefused([receipt])).not.toThrow();
      const plan = { stateDirs: [tmpDir()] };
      expect(isVolatileBackupPath(source.sourcePath, plan)).toBe(true);
      expect(isVolatileBackupPath(source.sourcePath + ".migrated", plan)).toBe(false);
      expect(isVolatileBackupPath(source.sourcePath + ".migrated.2", plan)).toBe(false);
      expect(
        isVolatileBackupPath(source.sourcePath + ".media.migrated/owned.png.sha256", plan),
      ).toBe(false);
      expectArchived(source);
    },
  );
  it.each(
    QUEUES.flatMap((queue) => [
      { ...queue, marker: "opaque" },
      { ...queue, marker: "canonical" },
    ]),
  )("$queueName: applies $marker delivered evidence to every duplicate ID", async (queue) => {
    const first = writeEntry(queue, "one.json", legacyEntry(queue, "equal"));
    const second = writeEntry(queue, "two.json", legacyEntry(queue, "equal"));
    const unrelated = writeEntry(queue, "other.json", legacyEntry(queue, "other"));
    const marker = writeEntry(
      queue,
      "one.delivered",
      queue.marker === "opaque" ? "acknowledged" : { id: "equal" },
    );
    await migrate();
    expect(
      database()
        .prepare("SELECT id, status FROM delivery_queue_entries WHERE queue_name = ? ORDER BY id")
        .all(queue.queueName),
    ).toEqual([{ id: "other", status: "pending" }]);
    for (const source of [first, second, unrelated, marker]) {
      expectArchived(source);
    }
  });
});
