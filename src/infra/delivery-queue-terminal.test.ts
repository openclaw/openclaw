import fs from "node:fs";
import type { StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { deriveDeliveryQueueRetentionColumns } from "./delivery-queue-retention-columns.js";
import { pruneDeliveryQueueTombstones } from "./delivery-queue-sqlite-bound.js";
import {
  countFailedDeliveryQueueEntries,
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

describe("delivery queue pending terminal transition", () => {
  let stateDir: string;
  const tempDirs = createTempDirTracker();
  const queueName = "terminal-test";
  const openTestDatabase = () =>
    openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
  const status = (id: string, ownerQueue = queueName) =>
    getDeliveryQueueEntryStatus(ownerQueue, id, stateDir);
  const seed = <T extends DeliveryQueueEntryState>(
    entry: T,
    ownerQueue = queueName,
    storedStatus: "pending" | "failed" | "completed" = "pending",
  ) => {
    seedDeliveryQueueEntry({ queueName: ownerQueue, entry, status: storedStatus, stateDir });
    return entry;
  };
  const terminalize = (entry: DeliveryQueueEntryState, ownerQueue = queueName) =>
    terminalizePendingDeliveryQueueEntry({ queueName: ownerQueue, id: entry.id, entry, stateDir });
  const terminalizeInDatabase = (entry: DeliveryQueueEntryState, ownerQueue = queueName) =>
    terminalizePendingDeliveryQueueEntryInDatabase(
      openTestDatabase(),
      prepareDeliveryQueueTerminalEntry({ queueName: ownerQueue, id: entry.id, entry }),
    );
  const storedRow = (id: string, columns = "*", ownerQueue = queueName) =>
    openTestDatabase()
      .db.prepare(`SELECT ${columns} FROM delivery_queue_entries WHERE queue_name = ? AND id = ?`)
      .get(ownerQueue, id);
  const rowIds = (db: ReturnType<typeof requireNativeSqliteDatabase>, ownerQueue = queueName) =>
    db
      .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = ? ORDER BY id")
      .all(ownerQueue)
      .map((row) => row.id);

  const makeRetention = (idPrefix: string, maxAgeMs = 60_000, maxEntries = 2) => ({
    idPrefix,
    maxAgeMs,
    maxEntries,
  });
  const boundedRetention = makeRetention("terminal-bounded-", 24 * 60 * 60_000);
  const terminalEntryRetention = makeRetention("terminal-");

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
    stateDir = tempDirs.make("openclaw-dq-terminal-");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    tempDirs.cleanup();
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

  it("bounds failed producer fences without pruning siblings or permanent owners", () => {
    vi.useFakeTimers();
    const producerRetention = { ...boundedRetention, idPrefix: "producer:" };
    const terminalReads: number[] = [];
    const fail = (
      id: string,
      time: number,
      completionRetention: DeliveryQueueCompletionRetention = producerRetention,
    ) => {
      vi.setSystemTime(time);
      const entry = { id, enqueuedAt: Date.now(), retryCount: 0, completionRetention };
      seed(entry);
      const database = openTestDatabase();
      const reads = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(database.db),
        ["queue"],
        (sql) =>
          sql.startsWith("select ") && sql.includes('from "delivery_queue_entries"')
            ? "queue"
            : null,
      );
      try {
        expect(terminalizeInDatabase(entry).status).toBe("terminalized");
        terminalReads.push(reads.counts.queue);
      } finally {
        reads.restore();
      }
      return id;
    };
    const firstId = fail("producer:failed-a", 1_000);
    const secondId = fail("producer:failed-b", 2_000);
    const thirdId = fail("producer:failed-c", 3_000);
    const triggerId = `${producerRetention.idPrefix}completed-d`;
    const siblingRetention = {
      ...producerRetention,
      idPrefix: "producer:child:",
    };
    expect(storedRow(firstId)).toBeUndefined();
    expect([status(firstId), status(secondId), status(thirdId)]).toEqual([
      undefined,
      "failed",
      "failed",
    ]);

    const siblingId = fail("producer:child:failed", 3_100, siblingRetention);
    const permanentId = fail("producer:permanent", 3_200, "permanent");
    expect(terminalReads).toEqual([0, 0, 0, 0, 0]);
    vi.setSystemTime(4_000);
    seed({
      id: triggerId,
      enqueuedAt: Date.now(),
      retryCount: 0,
      completionRetention: producerRetention,
    });
    completeDeliveryQueueEntryInDatabase(openTestDatabase(), queueName, triggerId);

    expect([secondId, thirdId, triggerId, siblingId, permanentId].map((id) => status(id))).toEqual([
      undefined,
      "failed",
      "completed",
      "failed",
      "failed",
    ]);
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
      seed(
        { id: ordinaryId, enqueuedAt: Date.now() - 31 * 24 * 60 * 60_000, retryCount: 0 },
        otherQueue,
        "completed",
      );
      const retainedIds = (ownerQueue: string) => rowIds(db, ownerQueue);
      // A missing-id lookup must stay on the primary-key path and leave the
      // backfilled over-cap group untouched.
      expect(status("missing")).toBeUndefined();
      expect(retainedIds(queueName)).toEqual(ids.toSorted());
      const originalPrepare = db.prepare.bind(db);
      const pruningQueries = new Map<StatementSync, string>();
      const prepare = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (/^with\s/i.test(sql)) {
          pruningQueries.set(statement, statement.expandedSQL);
          statement.run = new Proxy(statement.run.bind(statement), {
            apply(invoke, receiver: StatementSync, args) {
              const result = Reflect.apply(invoke, receiver, args);
              // Capture bindings before the executor releases the statement.
              pruningQueries.set(statement, statement.expandedSQL);
              return result;
            },
          });
        }
        return statement;
      });
      try {
        if (mode === "exact lookup") {
          expect(status(ids[0])).toBeUndefined();
          const prune = pruningQueries.values().next().value;
          expect(prune).toBeDefined();
          const plan = db
            .prepare(`EXPLAIN QUERY PLAN ${prune!}`)
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

  it("keeps malformed, unsettled, pending, and permanent owners during maintenance", async () => {
    const healthRetention = makeRetention("health:", 60_000, 1);
    const db = requireNativeSqliteDatabase(openTestDatabase().db);
    insertRetained(db, "health:expired", Date.now() - 60_001, healthRetention);
    insertRetained(db, "health:permanent", 1_000, "permanent");
    insertRetained(db, "health:malformed", 1_000, healthRetention, queueName, "{broken");
    for (const [id, rowStatus, recoveryState] of [
      ["health:completed-permanent", "completed", "completed_permanent"],
      ["health:pending", "pending", undefined],
      ["health:settlement", "failed", "settlement_pending"],
    ] as const) {
      seed({ id, enqueuedAt: 1_000, retryCount: 0, recoveryState }, queueName, rowStatus);
    }

    const retained = [
      "health:completed-permanent",
      "health:malformed",
      "health:pending",
      "health:permanent",
      "health:settlement",
    ];
    await countFailedDeliveryQueueEntries(stateDir);
    expect(rowIds(db)).toEqual([...retained, "health:expired"].toSorted());
    await pruneExpiredDeliveryQueueTombstones(stateDir);
    expect(rowIds(db)).toEqual(retained);
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
    [
      "durable completion owner",
      { deliveryCompletion: { kind: "conversation", operationId: "op-1" } },
      "permanent",
    ],
    ["claimed session", { availableAt: 60_000 }, "permanent", "session"],
    [
      "unowned legacy claim and send evidence",
      {
        failureRetention: "none",
        requiresProducerClaim: true,
        producerClaimId: "claim-1",
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
      seed(entry, ownerQueue);
      vi.useFakeTimers();
      vi.setSystemTime(50_000);
      expect(terminalize(entry, ownerQueue)).toEqual({ status: "terminalized", retained });
      expect(status(entry.id, ownerQueue)).toBe(retained ? "failed" : undefined);
      const row = storedRow(
        entry.id,
        `entry_kind, session_key, channel, target, account_id,
          last_attempt_at, last_error, recovery_state, platform_send_started_at,
          entry_json, enqueued_at, failed_at`,
        ownerQueue,
      );
      if (!retained) {
        expect(row).toBeUndefined();
        return;
      }
      const retention = expectedRetention ?? "permanent";
      const recoveryState = retention === "permanent" ? "completed_permanent" : "completed_bounded";
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
    },
  );

  it("does not terminalize a replacement pending owner", () => {
    const entry = { id: "terminal-race", enqueuedAt: 1_000, retryCount: 0 };
    seed(entry);
    updateDeliveryQueueEntryInDatabase(openTestDatabase(), queueName, entry.id, (current) => ({
      ...current,
      retryCount: 1,
    }));
    expect(terminalize(entry)).toEqual({ status: "not_pending" });
    expect(loadDeliveryQueueEntry(queueName, entry.id, stateDir)?.retryCount).toBe(1);
  });
});
