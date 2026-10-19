import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { deriveDeliveryQueueRetentionColumns } from "./delivery-queue-retention-columns.js";
import { pruneDeliveryQueueTombstones } from "./delivery-queue-sqlite-bound.js";
import {
  countFailedDeliveryQueueEntries,
  loadDeliveryQueueEntries,
  pruneExpiredDeliveryQueueTombstones,
  terminalizePendingDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import {
  completeDeliveryQueueEntryInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntry,
  seedDeliveryQueueEntry,
} from "./delivery-queue-sqlite.test-support.js";
import type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("delivery queue pending terminal transition", () => {
  let rootDir: string;
  let stateDir: string;
  const queueName = "terminal-test";
  const openTestDatabase = () =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
  const rowIds = (db: ReturnType<typeof requireNativeSqliteDatabase>, ownerQueue = queueName) =>
    db
      .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = ? ORDER BY id")
      .all(ownerQueue)
      .map((row) => row.id);

  const boundedRetention = {
    idPrefix: "terminal-bounded-",
    maxAgeMs: 24 * 60 * 60_000,
    maxEntries: 2,
  } as const;
  const terminalEntryRetention = {
    idPrefix: "terminal-",
    maxAgeMs: 60_000,
    maxEntries: 2,
  } as const;
  const enqueueRetained = (ownerQueue: string, id: string, enqueuedAt: number) => {
    const entry = { id, enqueuedAt, retryCount: 0, retainOnFailure: true as const };
    seedDeliveryQueueEntry({
      queueName: ownerQueue,
      entry,
      stateDir,
    });
    return entry;
  };

  function insertRetained(
    db: ReturnType<typeof requireNativeSqliteDatabase>,
    id: string,
    failedAt: number,
    completionRetention: DeliveryQueueCompletionRetention,
    ownerQueue = queueName,
    rawJson?: string,
  ) {
    const recoveryState =
      completionRetention === "permanent" ? "completed_permanent" : "completed_bounded";
    const entryJson =
      rawJson ??
      JSON.stringify({
        id,
        enqueuedAt: failedAt,
        retryCount: 0,
        failedAt,
        completionRetention,
        recoveryState,
      });
    db.prepare(`INSERT INTO delivery_queue_entries (
      queue_name, id, status, retry_count, recovery_state, entry_json,
      enqueued_at, updated_at, failed_at,
      retention_id_prefix, retention_max_age_ms, retention_max_entries
    ) VALUES (?, ?, 'failed', 0, ?, ?, ?, ?, ?,
      @retention_id_prefix, @retention_max_age_ms, @retention_max_entries)`).run(
      deriveDeliveryQueueRetentionColumns(id, entryJson),
      ownerQueue,
      id,
      recoveryState,
      entryJson,
      failedAt,
      failedAt,
      failedAt,
    );
  }

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-terminal-"));
    stateDir = path.join(rootDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("rejects mismatched terminal custody before creating state", () => {
    expect(() =>
      terminalizePendingDeliveryQueueEntry({
        queueName,
        id: "requested-owner",
        entry: { id: "different-owner", enqueuedAt: 1, retryCount: 0 },
        stateDir,
      }),
    ).toThrow("Delivery queue entry id mismatch");
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("expires a bounded failed fence during its exact replay lookup", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));
      const id = `${boundedRetention.idPrefix}failed-run`;
      const entry = {
        id,
        enqueuedAt: Date.now(),
        retryCount: 1,
        completionRetention: boundedRetention,
        payloads: [{ text: "private" }],
      };
      seedDeliveryQueueEntry({ queueName, entry, stateDir });
      expect(terminalizePendingDeliveryQueueEntry({ queueName, id, entry, stateDir })).toEqual({
        status: "terminalized",
        retained: true,
      });
      const { db } = openTestDatabase();
      const row = db
        .prepare(
          `SELECT entry_json FROM delivery_queue_entries
            WHERE queue_name = ? AND id = ? AND status = 'failed'`,
        )
        .get(queueName, id) as { entry_json: string };
      expect(JSON.parse(row.entry_json)).toEqual({
        id,
        enqueuedAt: Date.now(),
        retryCount: 1,
        failedAt: Date.now(),
        completionRetention: boundedRetention,
        recoveryState: "completed_bounded",
      });

      vi.setSystemTime(Date.now() + boundedRetention.maxAgeMs - 1);
      expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBe("failed");
      vi.setSystemTime(Date.now() + 2);
      expect(getDeliveryQueueEntryStatus(queueName, id, stateDir)).toBeUndefined();
      expect(
        db
          .prepare("SELECT 1 FROM delivery_queue_entries WHERE queue_name = ? AND id = ?")
          .get(queueName, id),
      ).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds failed producer fences without pruning siblings or permanent owners", () => {
    vi.useFakeTimers();
    try {
      const producerRetention = { ...boundedRetention, idPrefix: "producer:" };
      const fail = (
        ownerQueue: string,
        id: string,
        completionRetention: DeliveryQueueCompletionRetention,
      ) => {
        const entry = { id, enqueuedAt: Date.now(), retryCount: 0, completionRetention };
        seedDeliveryQueueEntry({ queueName: ownerQueue, entry, stateDir });
        const database = openTestDatabase();
        expect(
          terminalizePendingDeliveryQueueEntryInDatabase(
            database,
            prepareDeliveryQueueTerminalEntry({ queueName: ownerQueue, id, entry }),
          ).status,
        ).toBe("terminalized");
      };
      const firstId = `${producerRetention.idPrefix}failed-a`;
      const secondId = `${producerRetention.idPrefix}failed-b`;
      const thirdId = `${producerRetention.idPrefix}failed-c`;
      const triggerId = `${producerRetention.idPrefix}completed-d`;
      const siblingRetention = {
        ...producerRetention,
        idPrefix: "producer:child:",
      };
      const siblingId = `${siblingRetention.idPrefix}failed`;
      const permanentId = `${producerRetention.idPrefix}permanent`;
      vi.setSystemTime(1_000);
      fail(queueName, firstId, producerRetention);
      vi.setSystemTime(2_000);
      fail(queueName, secondId, producerRetention);
      vi.setSystemTime(3_000);
      fail(queueName, thirdId, producerRetention);
      expect(getDeliveryQueueEntryStatus(queueName, firstId, stateDir)).toBeUndefined();
      expect(getDeliveryQueueEntryStatus(queueName, secondId, stateDir)).toBe("failed");
      expect(getDeliveryQueueEntryStatus(queueName, thirdId, stateDir)).toBe("failed");

      vi.setSystemTime(3_100);
      fail(queueName, siblingId, siblingRetention);
      vi.setSystemTime(3_200);
      fail(queueName, permanentId, "permanent");
      vi.setSystemTime(4_000);
      seedDeliveryQueueEntry({
        queueName,
        entry: {
          id: triggerId,
          enqueuedAt: Date.now(),
          retryCount: 0,
          completionRetention: producerRetention,
        },
        stateDir,
      });
      completeDeliveryQueueEntryInDatabase(openTestDatabase(), queueName, triggerId);

      expect(getDeliveryQueueEntryStatus(queueName, secondId, stateDir)).toBeUndefined();
      expect(getDeliveryQueueEntryStatus(queueName, thirdId, stateDir)).toBe("failed");
      expect(getDeliveryQueueEntryStatus(queueName, triggerId, stateDir)).toBe("completed");
      expect(getDeliveryQueueEntryStatus(queueName, siblingId, stateDir)).toBe("failed");
      expect(getDeliveryQueueEntryStatus(queueName, permanentId, stateDir)).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["exact lookup", "global cleanup"] as const)(
    "groups backfilled bounded count limits by queue and producer prefix during %s",
    (mode) => {
      const db = requireNativeSqliteDatabase(openTestDatabase().db);
      const policies = [
        { ...boundedRetention, maxAgeMs: 12 * 60 * 60_000, maxEntries: 1 },
        { ...boundedRetention, maxAgeMs: 24 * 60 * 60_000, maxEntries: 1 },
      ] as const;
      const ids = ["terminal-bounded-old", "terminal-bounded-new"] as const;
      const otherQueue = "other-producer-queue";
      for (const ownerQueue of [queueName, otherQueue]) {
        insertRetained(db, ids[0], Date.now(), policies[0], ownerQueue);
        insertRetained(db, ids[1], Date.now() + 1, policies[1], ownerQueue);
      }
      const ordinaryId = "ordinary-completed";
      seedDeliveryQueueEntry({
        queueName: otherQueue,
        entry: { id: ordinaryId, enqueuedAt: Date.now() - 31 * 24 * 60 * 60_000, retryCount: 0 },
        status: "completed",
        stateDir,
      });
      const retainedIds = (ownerQueue: string) => rowIds(db, ownerQueue);
      // A missing-id lookup must stay on the primary-key path and leave the
      // backfilled over-cap group untouched.
      expect(getDeliveryQueueEntryStatus(queueName, "missing", stateDir)).toBeUndefined();
      expect(retainedIds(queueName)).toEqual(ids.toSorted());
      const prepare = vi.spyOn(db, "prepare");
      try {
        if (mode === "exact lookup") {
          expect(getDeliveryQueueEntryStatus(queueName, ids[0], stateDir)).toBeUndefined();
          const prune = prepare.mock.results
            .flatMap((result) => (result.type === "return" ? [result.value] : []))
            .find((statement) => /^with\s/i.test(statement.sourceSQL));
          expect(prune).toBeDefined();
          const plan = db
            .prepare(`EXPLAIN QUERY PLAN ${prune!.expandedSQL}`)
            .all()
            .map((row) => row.detail)
            .join("\n");
          expect(plan).toMatch(
            /SEARCH delivery_queue_entries USING INDEX \S+ \((?:queue_name=\? AND (?:status|retention_id_prefix)=\?|status=\? AND queue_name=\?)\)/,
          );
          expect(plan).not.toContain("SCAN delivery_queue_entries");
        } else {
          pruneDeliveryQueueTombstones(db, Date.now());
        }
      } finally {
        prepare.mockRestore();
      }
      expect(retainedIds(queueName)).toEqual([ids[1]]);
      expect(retainedIds(otherQueue)).toEqual(
        mode === "exact lookup" ? [ordinaryId, ...ids.toSorted()] : [ids[1]],
      );
    },
  );

  it("keeps health reads immutable and expires tombstones during maintenance", async () => {
    const now = Date.now();
    const hour = 60 * 60_000;
    const retention = { idPrefix: "health:", maxAgeMs: hour, maxEntries: 1 } as const;
    const db = requireNativeSqliteDatabase(openTestDatabase().db);
    insertRetained(db, "health:expired", now - 2 * hour, retention);
    insertRetained(db, "health:over-cap", now - hour / 2, retention);
    insertRetained(db, "health:newest", now - hour / 4, retention);
    insertRetained(db, "health:permanent", 1_000, "permanent");
    insertRetained(db, "health:malformed", 1_000, retention, queueName, "{broken");
    for (const [id, status, recoveryState, enqueuedAt] of [
      ["health:ordinary-completed", "completed", undefined, now - 31 * 24 * 60 * 60_000],
      ["health:ordinary-live", "completed", undefined, now],
      ["health:completed-permanent", "completed", "completed_permanent", 1_000],
      ["health:pending", "pending", undefined, 1_000],
      ["health:settlement", "failed", "settlement_pending", 1_000],
    ] as const) {
      seedDeliveryQueueEntry({
        queueName,
        entry: { id, enqueuedAt, retryCount: 0, recoveryState },
        status,
        stateDir,
      });
    }

    expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual([
      { queueName, count: 6, oldestFailedAt: 1_000 },
    ]);
    expect(rowIds(db)).toEqual([
      "health:completed-permanent",
      "health:expired",
      "health:malformed",
      "health:newest",
      "health:ordinary-completed",
      "health:ordinary-live",
      "health:over-cap",
      "health:pending",
      "health:permanent",
      "health:settlement",
    ]);

    await pruneExpiredDeliveryQueueTombstones(stateDir);
    expect(rowIds(db)).toEqual([
      "health:completed-permanent",
      "health:malformed",
      "health:newest",
      "health:ordinary-live",
      "health:over-cap",
      "health:pending",
      "health:permanent",
      "health:settlement",
    ]);
    expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual([
      { queueName, count: 5, oldestFailedAt: 1_000 },
    ]);
  });

  it("reports no failed queues when retained entries are pending", async () => {
    enqueueRetained("outbound", "pending-1", 1_000);
    expect(await countFailedDeliveryQueueEntries(stateDir)).toEqual([]);
  });

  it("counts failed rows per queue with their oldest failure", async () => {
    const first = enqueueRetained("outbound", "dead-1", 1_000);
    const second = enqueueRetained("outbound", "dead-2", 2_000);
    enqueueRetained("outbound", "still-pending", 3_000);
    const third = enqueueRetained("session", "dead-3", 4_000);
    const database = openTestDatabase();
    vi.useFakeTimers();
    try {
      for (const [ownerQueue, entry, failedAt] of [
        ["outbound", first, 50_000],
        ["outbound", second, 60_000],
        ["session", third, 70_000],
      ] as const) {
        vi.setSystemTime(failedAt);
        expect(
          terminalizePendingDeliveryQueueEntryInDatabase(
            database,
            prepareDeliveryQueueTerminalEntry({ queueName: ownerQueue, id: entry.id, entry }),
          ).status,
        ).toBe("terminalized");
      }
    } finally {
      vi.useRealTimers();
    }
    const { db } = database;
    db.prepare(
      "UPDATE delivery_queue_entries SET failed_at = NULL WHERE queue_name = 'session'",
    ).run();

    const prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    try {
      const counts = await countFailedDeliveryQueueEntries(stateDir);
      expect(counts.find((queue) => queue.queueName === "outbound")).toEqual({
        queueName: "outbound",
        count: 2,
        oldestFailedAt: 50_000,
      });
      expect(counts.find((queue) => queue.queueName === "session")).toEqual({
        queueName: "session",
        count: 1,
      });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
    }
    expect(loadDeliveryQueueEntries("outbound", stateDir).map((entry) => entry.id)).toEqual([
      "still-pending",
    ]);
  });

  it.each<
    [
      label: string,
      facts: Partial<DeliveryQueueEntryState> & {
        failureRetention?: DeliveryQueueCompletionRetention | "none";
        deliveryCompletion?: { kind: "conversation"; operationId: string };
      },
      expectedRetention?: DeliveryQueueCompletionRetention,
      ownerQueue?: string,
    ]
  >([
    ["ordinary", {}],
    ["explicit", { retainOnFailure: true }, "permanent"],
    [
      "completion owner before legacy policy",
      {
        completionRetention: terminalEntryRetention,
        failureRetention: "permanent",
      },
      terminalEntryRetention,
    ],
    ["permanent completion owner", { completionRetention: "permanent" }, "permanent"],
    [
      "bounded legacy failure owner",
      { failureRetention: terminalEntryRetention },
      terminalEntryRetention,
    ],
    ["permanent legacy failure owner", { failureRetention: "permanent" }, "permanent"],
    ["none legacy failure owner", { failureRetention: "none" }],
    ["producer claim required", { requiresProducerClaim: true }],
    [
      "durable completion owner",
      { deliveryCompletion: { kind: "conversation", operationId: "op-1" } },
      "permanent",
    ],
    ["claimed session", { availableAt: 60_000 }, "permanent", "session"],
    ["active producer claim", { producerClaimId: "claim-1" }],
    [
      "platform send evidence",
      {
        platformSendAttemptId: "attempt-1",
        platformSendStartedAt: 40_000,
        recoveryState: "unknown_after_send",
      },
    ],
    [
      "invalid bounded owner",
      { completionRetention: { idPrefix: "other-", maxAgeMs: 60_000, maxEntries: 2 } },
    ],
  ])(
    "removes private state for %s failure",
    (label, facts, expectedRetention, ownerQueue = queueName) => {
      const retained = expectedRetention !== undefined;
      const entry = {
        id: `terminal-${label}`,
        enqueuedAt: 1_000,
        retryCount: 2,
        ...facts,
        sessionKey: "private-session",
        channel: "private-channel",
        to: "private-target",
        accountId: "private-account",
        lastError: "raw provider error",
        payloads: [{ text: "private payload", mediaUrl: "/private/media" }],
      };
      seedDeliveryQueueEntry({ queueName: ownerQueue, entry, stateDir });
      vi.useFakeTimers();
      try {
        vi.setSystemTime(50_000);
        expect(
          terminalizePendingDeliveryQueueEntry({
            queueName: ownerQueue,
            id: entry.id,
            entry,
            stateDir,
          }),
        ).toEqual({ status: "terminalized", retained });
        expect(getDeliveryQueueEntryStatus(ownerQueue, entry.id, stateDir)).toBe(
          retained ? "failed" : undefined,
        );
        const { db } = openTestDatabase();
        const row = db
          .prepare(
            `SELECT entry_kind, session_key, channel, target, account_id, last_attempt_at,
                    last_error, recovery_state, platform_send_started_at, entry_json,
                    enqueued_at, failed_at
               FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`,
          )
          .get(ownerQueue, entry.id) as Record<string, unknown> | undefined;
        if (!retained) {
          expect(row).toBeUndefined();
          return;
        }
        const retention = expectedRetention ?? "permanent";
        const recoveryState =
          retention === "permanent" ? "completed_permanent" : "completed_bounded";
        expect(row).toEqual({
          entry_kind: null,
          session_key: null,
          channel: null,
          target: null,
          account_id: null,
          last_attempt_at: null,
          last_error: null,
          recovery_state: recoveryState,
          platform_send_started_at: null,
          entry_json: JSON.stringify({
            id: entry.id,
            enqueuedAt: 50_000,
            retryCount: 2,
            failedAt: 50_000,
            completionRetention: retention,
            recoveryState,
          }),
          enqueued_at: 50_000,
          failed_at: 50_000,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not terminalize a replacement pending owner", () => {
    const entry = { id: "terminal-race", enqueuedAt: 1_000, retryCount: 0 };
    seedDeliveryQueueEntry({ queueName, entry, stateDir });
    updateDeliveryQueueEntryInDatabase(openTestDatabase(), queueName, entry.id, (current) => ({
      ...current,
      retryCount: 1,
    }));
    expect(
      terminalizePendingDeliveryQueueEntry({ queueName, id: entry.id, entry, stateDir }),
    ).toEqual({ status: "not_pending" });
    expect(loadDeliveryQueueEntry(queueName, entry.id, stateDir)?.retryCount).toBe(1);
  });
});
