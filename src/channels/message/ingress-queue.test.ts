import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import type { Insertable } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { countFailedChannelIngressQueueEntries } from "./ingress-queue-health.js";
import {
  createChannelIngressQueue,
  listChannelIngressQueueAccountIdsReadOnly,
} from "./ingress-queue.js";
import { createTestIngressQueue, useRetainedIngressState } from "./ingress-queue.test-helpers.js";
import { channelIngressOperations } from "./ingress-queue.worker.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

async function withIsolatedState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-queue-", applyEnv: false },
    ({ stateDir }) => fn(stateDir),
  );
}

const withTempState = useRetainedIngressState(afterAll);

function openIngressStateDatabase(stateDir: string) {
  return openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
}

describe("channel ingress queue", () => {
  it("reads committed claim states without a transaction for single-statement inspections", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("pending", { text: "waiting" });
      await queue.enqueue("claimed", { text: "active" });
      await queue.enqueue("failed", { text: "rejected" });
      await queue.claim("claimed");
      await queue.fail("failed", { reason: "rejected" });
      const database = openIngressStateDatabase(stateDir);
      const context = {
        open: () => database,
        stateOptions: () => ({ path: database.path, env: { OPENCLAW_STATE_DIR: stateDir } }),
      };
      const queueName = JSON.stringify(["test", "account"]);
      const transactionSql = vi.spyOn(database.db, "exec");
      try {
        for (const [status, ids] of [
          ["claimed", ["claimed"]],
          ["failed", ["failed"]],
          ["unsettled", ["claimed", "pending"]],
        ] as const) {
          const rows = channelIngressOperations["channelIngress.list"](
            { queueName, status, readOnly: false, orderBy: "id" },
            context,
          );
          expect(rows.map((row) => row.event_id)).toEqual(ids);
        }
        const snapshot = channelIngressOperations["channelIngress.claimSnapshot"](
          { queueName, blockedLaneKeys: [], deriveLaneKey: false },
          context,
        );
        expect(snapshot.pending.map((row) => row.event_id)).toEqual(["pending"]);
        expect(snapshot.claimed).toEqual([]);
        expect(transactionSql).not.toHaveBeenCalled();
      } finally {
        transactionSql.mockRestore();
      }
    });
  });

  it("rejects empty claim IDs through its async result", async () => {
    const queue = createChannelIngressQueue({ channelId: "invalid-input" });
    const invalid = { id: " ", claim: { token: "fixture" } };
    const result = queue.refreshClaim!(invalid);
    await expect(result).rejects.toThrow("Channel ingress event id cannot be empty");
  });

  it.each(["cold", "warm"] as const)(
    "preserves append and prune order with a %s writer",
    async (writer) => {
      await withIsolatedState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        if (writer === "warm") {
          await queue.enqueue("warmup", { text: "already processed" });
          await queue.complete("warmup");
        }

        const first = queue.enqueue("first", { text: "before prune" });
        const pruning = queue.prune({ pendingMaxEntries: 0 });
        const second = queue.enqueue("second", { text: "after prune" });
        const [, deleted] = await Promise.all([first, pruning, second]);

        expect(deleted).toBe(1);
        expect((await queue.listPending()).map((row) => row.id)).toEqual(["second"]);
      });
    },
  );

  it("purges all states only for the selected channel and account", async () => {
    await withIsolatedState(async (stateDir) => {
      const queues = [
        createChannelIngressQueue({ channelId: "telegram", accountId: "a", stateDir }),
        createChannelIngressQueue({ channelId: "telegram", accountId: "b", stateDir }),
        createChannelIngressQueue({ channelId: "other", accountId: "a", stateDir }),
      ] as const;
      const states = ["pending", "claimed", "completed", "failed"] as const;
      for (const queue of queues) {
        for (const state of states) {
          await queue.enqueue(state, { text: "old identity" });
        }
        await queue.claim("claimed");
        await queue.complete("completed");
        await queue.fail("failed", { reason: "rejected" });
      }

      expect(await queues[0].purge?.()).toBe(4);
      expect(await queues[0].purge?.()).toBe(0);
      for (const state of states) {
        expect(await queues[0].enqueue(state, { text: "new identity" })).toMatchObject({
          kind: "accepted",
          duplicate: false,
        });
        for (const queue of queues.slice(1)) {
          expect(await queue.enqueue(state, { text: "duplicate" })).toMatchObject({
            kind: state,
            duplicate: true,
          });
        }
      }
    });
  });
  it("rolls back a purge when its account is cancelled before commit", async () => {
    await withIsolatedState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("pending", { text: "pending" });
      await queue.enqueue("claimed", { text: "claimed" });
      await queue.claim("claimed");
      const pending = await queue.listPending();
      const claims = await queue.listClaims();
      const controller = new AbortController();
      let reachedCommit = false;
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === "commit") {
          reachedCommit = true;
          controller.abort(new Error("account task retired"));
        }
        admit(request, grant);
      });
      try {
        await expect(queue.purge?.({ signal: controller.signal })).rejects.toThrow(
          "account task retired",
        );
        expect(reachedCommit).toBe(true);
        expect(await queue.listPending()).toEqual(pending);
        expect(await queue.listClaims()).toEqual(claims);
      } finally {
        admission.mockRestore();
      }
    });
  });

  it("deduplicates pending and completed ingress events", async () => {
    await withIsolatedState(async (stateDir) => {
      const queue = createTestIngressQueue<
        { text: string },
        { source: string },
        { handledBy: string }
      >(stateDir, { now: () => 100 });

      const rejectHostQuery = () => {
        throw new Error("Ingress queue operations must not query SQLite on the calling thread");
      };
      const hostQuery = vi
        .spyOn(sqliteQueries, "executeSqliteQuerySync")
        .mockImplementation(rejectHostQuery);
      const hostFirstQuery = vi
        .spyOn(sqliteQueries, "executeSqliteQueryTakeFirstSync")
        .mockImplementation(rejectHostQuery);
      try {
        const accepted = await queue.enqueue(
          "event-1",
          { text: "first" },
          { metadata: { source: "fixture" }, receivedAt: 50 },
        );
        const pending = await queue.enqueue("event-1", { text: "duplicate" });
        const claim = await queue.claim("event-1", { ownerId: "worker" });
        expect(claim?.id).toBe("event-1");
        await queue.complete(expectDefined(claim, "claimed event"), {
          metadata: { handledBy: "worker" },
          completedAt: 150,
        });
        const completed = await queue.enqueue("event-1", { text: "late duplicate" });

        expect(accepted.kind).toBe("accepted");
        expect(pending.kind).toBe("pending");
        if (pending.kind !== "pending") {
          throw new Error(`Expected pending duplicate, got ${pending.kind}`);
        }
        expect(pending.record.payload).toEqual({ text: "first" });
        expect(completed).toEqual({
          kind: "completed",
          duplicate: true,
          record: {
            id: "event-1",
            channelId: "test",
            accountId: "account",
            queueName: JSON.stringify(["test", "account"]),
            completedAt: 150,
            metadata: { handledBy: "worker" },
          },
        });
        expect(await queue.listPending()).toEqual([]);

        expect(
          await queue.complete("missing-event", {
            metadata: { handledBy: "late-worker" },
            completedAt: 200,
          }),
        ).toBe(true);
        expect(await queue.enqueue("missing-event", { text: "late duplicate" })).toMatchObject({
          kind: "completed",
          duplicate: true,
          record: {
            id: "missing-event",
            completedAt: 200,
            metadata: { handledBy: "late-worker" },
          },
        });

        await queue.enqueue(" spaced-event ", { text: "spaced" });
        expect(await queue.complete(" spaced-event ", { completedAt: 250 })).toBe(true);
        expect(await queue.enqueue("spaced-event", { text: "duplicate" })).toMatchObject({
          kind: "completed",
          duplicate: true,
          record: { id: "spaced-event", completedAt: 250 },
        });
        expect(await queue.prune({ completedMaxEntries: 0 })).toBe(3);
        expect(hostQuery).not.toHaveBeenCalled();
        expect(hostFirstQuery).not.toHaveBeenCalled();
      } finally {
        hostQuery.mockRestore();
        hostFirstQuery.mockRestore();
      }
    });
  });

  it("keeps channel and account queue identities unambiguous", async () => {
    await withTempState(async (stateDir) => {
      const first = createChannelIngressQueue<{ text: string }>({
        channelId: "discord",
        accountId: "account-a",
        stateDir,
      });
      const second = createChannelIngressQueue<{ text: string }>({
        channelId: "discord",
        accountId: "account-b",
        stateDir,
      });

      expect(
        await first.enqueue("same-id", { text: "first" }, { laneKey: "channel:same-lane" }),
      ).toMatchObject({
        kind: "accepted",
      });
      expect(
        await second.enqueue("same-id", { text: "second" }, { laneKey: "channel:same-lane" }),
      ).toMatchObject({
        kind: "accepted",
      });

      const firstClaim = await first.claim("same-id", { ownerId: "first-worker" });
      expect(firstClaim).not.toBeNull();
      if (!firstClaim) {
        return;
      }
      await first.fail(firstClaim, { reason: "poison", failedAt: 20 });

      expect(await first.enqueue("same-id", { text: "first duplicate" })).toMatchObject({
        kind: "failed",
      });
      expect(await second.enqueue("same-id", { text: "second duplicate" })).toMatchObject({
        kind: "pending",
        record: { payload: { text: "second" } },
      });

      if (!first.resubmit) {
        return;
      }
      await expect(first.resubmit("same-id", { resubmittedAt: 30 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: { attempts: 0, laneKey: "channel:same-lane", payload: { text: "first" } },
      });
      const resubmittedClaim = await first.claim("same-id", { ownerId: "replacement" });
      const secondClaim = await second.claim("same-id", { ownerId: "second-worker" });
      expect(resubmittedClaim).not.toBeNull();
      expect(secondClaim).not.toBeNull();
      if (!resubmittedClaim || !secondClaim) {
        return;
      }
      await first.fail(resubmittedClaim, { reason: "poison-again", failedAt: 40 });
      await second.complete(secondClaim, { completedAt: 40 });

      expect(await first.prune({ failedTtlMs: 1, now: 42 })).toBe(1);
      expect(await first.enqueue("same-id", { text: "fresh after prune" })).toMatchObject({
        kind: "accepted",
      });
      expect(await second.enqueue("same-id", { text: "completed duplicate" })).toMatchObject({
        kind: "completed",
      });
    });
  });

  it("claims next only from candidate ids when provided", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ text: string }>(stateDir, { now: () => clock++ });

      await queue.enqueue("a", { text: "outside snapshot" }, { receivedAt: 1 });
      await queue.enqueue("b", { text: "inside snapshot" }, { receivedAt: 2 });

      expect(
        await queue.claimNext({
          ownerId: "worker",
          candidateIds: ["b"],
        }),
      ).toMatchObject({ id: "b" });
      expect(await queue.claimNext({ candidateIds: [] })).toBeNull();
    });
  });

  it("preserves durable lanes when a channel derives ephemeral claim lanes", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ text: string }>(stateDir, { now: () => clock++ });

      await queue.enqueue("message-1", { text: "debounced" }, { laneKey: "chat:123" });

      const claimed = await queue.claimNext({
        ownerId: "imessage-worker",
        deriveLaneKey: (record) => `${record.laneKey ?? "event"}:${record.id}`,
      });

      expect(claimed?.laneKey).toBe("chat:123");
      expect((await queue.listClaims())[0]?.laneKey).toBe("chat:123");
    });
  });

  it("rechecks FIFO when an earlier event arrives while claim lanes are prepared", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => 20 });
      await queue.enqueue("original", { lane: "chat-original" }, { receivedAt: 20 });
      const { db } = openIngressStateDatabase(stateDir);
      let inserted = false;
      const claim = await queue.claimNext({
        ownerId: "worker",
        deriveLaneKey: (record) => {
          if (!inserted) {
            inserted = true;
            // A competing writer commits after the candidate snapshot was read.
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
                .insertInto("channel_ingress_events")
                .values({
                  queue_name: JSON.stringify(["test", "account"]),
                  event_id: "earlier",
                  channel_id: "test",
                  account_id: "account",
                  status: "pending",
                  payload_json: JSON.stringify({ lane: "chat-earlier" }),
                  received_at: 10,
                  updated_at: 20,
                }),
            );
          }
          return record.payload.lane;
        },
      });
      expect(claim).toMatchObject({ id: "earlier", laneKey: "chat-earlier" });
      expect((await queue.listPending()).map((record) => record.id)).toEqual(["original"]);
    });
  });

  it("blocks opted-in legacy candidate lanes using their canonical owner", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      await queue.enqueue(
        "a",
        { lane: "chat:123" },
        { laneKey: "chat:123:topic:7", receivedAt: 1 },
      );
      await queue.enqueue(
        "b",
        { lane: "chat:123" },
        { laneKey: "chat:123:topic:8", receivedAt: 2 },
      );
      await queue.enqueue(
        "c",
        { lane: "chat:456" },
        { laneKey: "chat:456:topic:9", receivedAt: 3 },
      );
      await queue.claim("a", { ownerId: "sibling-worker" });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        candidateIds: ["a", "b", "c"],
        orderBy: "id",
        deriveLaneKey: (record) => record.payload.lane,
        reconcileStoredLaneKey: (_record, storedLaneKey, derivedLaneKey) =>
          storedLaneKey.startsWith(`${derivedLaneKey}:topic:`),
      });

      expect(claimed?.id).toBe("c");
      expect(claimed?.laneKey).toBe("chat:456");
      expect((await queue.listClaims()).find((record) => record.id === "a")?.laneKey).toBe(
        "chat:123:topic:7",
      );
      expect((await queue.listPending())[0]?.laneKey).toBe("chat:123:topic:8");
    });
  });

  it("preserves persisted lanes when an owner rejects their reconciliation", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      await queue.enqueue("a", { lane: "chat:123" }, { laneKey: "chat:999:topic:7" });

      const claimed = await queue.claimNext({
        ownerId: "worker",
        deriveLaneKey: (record) => record.payload.lane,
        reconcileStoredLaneKey: (_record, storedLaneKey, derivedLaneKey) =>
          storedLaneKey === `${derivedLaneKey}:topic:7`,
      });

      expect(claimed?.laneKey).toBe("chat:999:topic:7");
      expect((await queue.listClaims())[0]?.laneKey).toBe("chat:999:topic:7");
    });
  });

  describe("corrupt JSON resilience", () => {
    function readStoredRow<
      TColumn extends keyof OpenClawStateKyselyDatabase["channel_ingress_events"],
    >(stateDir: string, eventId: string, columns: TColumn[]) {
      const { db } = openIngressStateDatabase(stateDir);
      return executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
          .selectFrom("channel_ingress_events")
          .select(columns)
          .where("queue_name", "=", '["test","account"]')
          .where("event_id", "=", eventId),
      );
    }

    function insertCorruptRow(
      stateDir: string,
      queueName: string,
      eventId: string,
      overrides: Partial<{
        payload_json: string;
        metadata_json: string | null;
        completed_metadata_json: string | null;
        status: string;
        claim_token: string;
        claim_owner: string;
        claimed_at: number;
        completed_at: number;
      }>,
    ) {
      const { db } = openIngressStateDatabase(stateDir);
      const kysely = getNodeSqliteKysely<ChannelIngressTestDatabase>(db);
      const claimValue = overrides.claim_token ?? null;
      executeSqliteQuerySync(
        db,
        kysely.insertInto("channel_ingress_events").values({
          queue_name: queueName,
          event_id: eventId,
          channel_id: "test",
          account_id: "account",
          status: overrides.status ?? "pending",
          lane_key: null,
          payload_json: overrides.payload_json ?? "null",
          metadata_json: overrides.metadata_json ?? null,
          completed_metadata_json: overrides.completed_metadata_json ?? null,
          received_at: 100,
          updated_at: 200,
          attempts: 0,
          claim_token: claimValue,
          claim_owner: overrides.claim_owner ?? null,
          claimed_at: overrides.claimed_at ?? null,
          completed_at: overrides.completed_at ?? null,
        } as Insertable<OpenClawStateKyselyDatabase["channel_ingress_events"]>),
      );
    }

    it("applies listPending limits after excluding corrupt payloads", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        for (let index = 0; index < 100; index += 1) {
          insertCorruptRow(
            stateDir,
            '["test","account"]',
            `bad-${index.toString().padStart(3, "0")}`,
            { payload_json: "{corrupt" },
          );
        }
        await queue.enqueue("good-second", { text: "visible" }, { receivedAt: 300 });

        const pending = await queue.listPending({ limit: 1 });

        expect(pending.map((record) => record.id)).toEqual(["good-second"]);
      });
    });

    it("uses the queue JSON contract when listing deeply nested payloads", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<unknown>(stateDir);
        const nestedJson = `${"[".repeat(1001)}0${"]".repeat(1001)}`;
        const payload = JSON.parse(nestedJson);

        await queue.enqueue("deep", payload);

        await expect(queue.listPending({ limit: 1 })).resolves.toMatchObject([{ id: "deep" }]);
      });
    });

    it("makes durable progress when a corrupt prefix fills the claim scan limit", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        insertCorruptRow(stateDir, '["test","account"]', "bad-first", {
          payload_json: "{corrupt",
        });
        await queue.enqueue("good-second", { text: "claimable" }, { receivedAt: 300 });

        await expect(queue.claimNext({ scanLimit: 1 })).resolves.toMatchObject({
          id: "good-second",
          payload: { text: "claimable" },
        });
        expect(
          readStoredRow(stateDir, "bad-first", ["status", "failed_reason", "payload_json"]),
        ).toEqual({ status: "failed", failed_reason: "corrupt_payload", payload_json: "null" });
      });
    });

    it("bounds corrupt reconciliation work per claimNext call", async () => {
      await withTempState(async (stateDir) => {
        const queueName = '["test","account"]';
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        for (let index = 0; index < 101; index += 1) {
          insertCorruptRow(stateDir, queueName, `bad-${index.toString().padStart(3, "0")}`, {
            payload_json: "{corrupt",
          });
        }

        await expect(queue.claimNext({ scanLimit: 200 })).resolves.toBeNull();

        const database = openIngressStateDatabase(stateDir);
        const counts = executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(database.db)
            .selectFrom("channel_ingress_events")
            .select(["status"])
            .where("queue_name", "=", queueName),
        ).rows;
        expect(counts.filter((row) => row.status === "failed")).toHaveLength(100);
        expect(counts.filter((row) => row.status === "pending")).toHaveLength(1);

        await expect(queue.claimNext({ scanLimit: 200 })).resolves.toBeNull();
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      });
    });

    it("claim returns null for a corrupt pending row", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);

        await queue.enqueue("good-1", { text: "hello" });
        insertCorruptRow(stateDir, '["test","account"]', "bad-direct", {
          payload_json: "{corrupt",
        });

        // The corrupt row should not be claimable.
        const badClaim = await queue.claim("bad-direct");
        expect(badClaim).toBeNull();

        // The good row should still be claimable.
        const goodClaim = await queue.claim("good-1");
        expect(goodClaim).not.toBeNull();
        expect(goodClaim!.payload.text).toBe("hello");

        const failed = readStoredRow(stateDir, "bad-direct", ["status", "failed_reason"]);
        expect(failed).toEqual({ status: "failed", failed_reason: "corrupt_payload" });
      });
    });

    it("tombstones a corrupt pending row on duplicate enqueue", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);

        insertCorruptRow(stateDir, '["test","account"]', "dup-bad", {
          payload_json: "{corrupt",
        });

        const result = await queue.enqueue("dup-bad", { text: "late" });
        expect(result.kind).toBe("failed");
        if (result.kind === "failed") {
          expect(result.duplicate).toBe(true);
          expect(result.record.reason).toBe("corrupt_payload");
        }

        // Verify the corrupt row was actually tombstoned in the DB.
        const row = readStoredRow(stateDir, "dup-bad", [
          "status",
          "failed_reason",
          "payload_json",
          "claim_token",
          "claimed_at",
        ]);
        expect(row?.status).toBe("failed");
        expect(row?.failed_reason).toBe("corrupt_payload");
        expect(row?.payload_json).toBe("null");
        expect(row?.claim_token).toBeNull();
        expect(row?.claimed_at).toBeNull();
      });
    });

    it("does not tombstone a corrupt actively claimed row on duplicate enqueue", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        insertCorruptRow(stateDir, '["test","account"]', "dup-claimed-bad", {
          payload_json: "{corrupt",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 200,
        });

        await expect(queue.enqueue("dup-claimed-bad", { text: "late" })).rejects.toThrow(
          "Corrupt claimed channel ingress event",
        );

        const row = readStoredRow(stateDir, "dup-claimed-bad", [
          "status",
          "payload_json",
          "claim_token",
          "claim_owner",
          "claimed_at",
        ]);
        expect(row).toEqual({
          status: "claimed",
          payload_json: "{corrupt",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 200,
        });
      });
    });

    it("tombstones corrupt claimed rows during stale recovery", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);

        const oldTime = 10;
        insertCorruptRow(stateDir, '["test","account"]', "stale-bad", {
          payload_json: "{corrupt",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "worker",
          claimed_at: oldTime,
        });

        const recovered = await queue.recoverStaleClaims({
          staleMs: Date.now() - oldTime,
        });
        expect(recovered).toBe(1);

        // The corrupt claimed row should now be tombstoned as failed.
        const row = readStoredRow(stateDir, "stale-bad", [
          "status",
          "failed_reason",
          "payload_json",
          "claim_token",
          "claimed_at",
        ]);
        expect(row?.status).toBe("failed");
        expect(row?.failed_reason).toBe("corrupt_payload");
        expect(row?.payload_json).toBe("null");
        expect(row?.claim_token).toBeNull();
        expect(row?.claimed_at).toBeNull();
        await expect(queue.recoverStaleClaims({ staleMs: Date.now() - oldTime })).resolves.toBe(0);
      });
    });

    it("tombstones malformed claims regardless of timestamp and keeps them resubmittable", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        const payload = JSON.stringify({ text: "still valid" });
        // Valid payloads, but incomplete claim columns: no owner can ever
        // release these rows. A NULL claimed_at dodges cutoff-based scans, and
        // a corrupt future claimed_at dodges every cutoff comparison; the
        // missing columns alone must pull both rows into the recovery scan.
        insertCorruptRow(stateDir, '["test","account"]', "claimless", {
          payload_json: payload,
          status: "claimed",
        });
        insertCorruptRow(stateDir, '["test","account"]', "future-ownerless", {
          payload_json: payload,
          status: "claimed",
          claim_token: "test-token-placeholder",
          claimed_at: 1_000_000,
        });

        await expect(queue.listClaims()).resolves.toEqual([]);

        const shouldRecoverCorrupt = vi.fn(() => false);
        await expect(
          queue.recoverStaleClaims({ staleMs: 10, now: 20, shouldRecoverCorrupt }),
        ).resolves.toBe(2);
        // No reachable owner exists, so ownership policy is not consulted.
        expect(shouldRecoverCorrupt).not.toHaveBeenCalled();

        const { db } = openIngressStateDatabase(stateDir);
        const rows = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .selectFrom("channel_ingress_events")
            .select(["event_id", "status", "failed_reason", "payload_json", "claim_token"])
            .where("queue_name", "=", '["test","account"]')
            .orderBy("event_id", "asc"),
        ).rows;
        expect(rows).toEqual([
          {
            event_id: "claimless",
            status: "failed",
            failed_reason: "corrupt_claim",
            payload_json: payload,
            claim_token: null,
          },
          {
            event_id: "future-ownerless",
            status: "failed",
            failed_reason: "corrupt_claim",
            payload_json: payload,
            claim_token: null,
          },
        ]);

        const resubmitted = await queue.resubmit?.("claimless");
        expect(resubmitted?.kind).toBe("resubmitted");
      });
    });

    it("does not bypass recovery policy for a corrupt stale claim", async () => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue<{ text: string }>(stateDir);
        insertCorruptRow(stateDir, '["test","account"]', "stale-policy-bad", {
          payload_json: "{corrupt",
          status: "claimed",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 10,
        });
        const shouldRecover = vi.fn(() => true);
        const shouldRecoverCorrupt = vi.fn(() => false);

        await expect(
          queue.recoverStaleClaims({
            staleMs: 10,
            now: 20,
            shouldRecover,
            shouldRecoverCorrupt,
          }),
        ).resolves.toBe(0);
        expect(shouldRecover).not.toHaveBeenCalled();
        expect(shouldRecoverCorrupt).toHaveBeenCalledWith({
          id: "stale-policy-bad",
          channelId: "test",
          accountId: "account",
          queueName: '["test","account"]',
          reason: "corrupt_payload",
          claim: {
            token: "test-token-placeholder",
            ownerId: "active-worker",
            claimedAt: 10,
          },
        });

        const row = readStoredRow(stateDir, "stale-policy-bad", [
          "status",
          "payload_json",
          "claim_token",
          "claim_owner",
          "claimed_at",
        ]);
        expect(row).toEqual({
          status: "claimed",
          payload_json: "{corrupt",
          claim_token: "test-token-placeholder",
          claim_owner: "active-worker",
          claimed_at: 10,
        });

        await expect(
          queue.recoverStaleClaims({
            staleMs: 10,
            now: 20,
            shouldRecover,
            shouldRecoverCorrupt: () => true,
          }),
        ).resolves.toBe(1);
        const failed = readStoredRow(stateDir, "stale-policy-bad", ["status", "failed_reason"]);
        expect(failed).toEqual({ status: "failed", failed_reason: "corrupt_payload" });
      });
    });
  });
});

describe("channel ingress dead letters", () => {
  it("retains failed payload, metadata, and attempt history", async () => {
    await withIsolatedState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }, { source: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });

      await queue.enqueue(
        "event-1",
        { text: "recover me" },
        { metadata: { source: "webhook" }, receivedAt: 5, laneKey: "chat-1" },
      );
      const firstClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!firstClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.release(firstClaim, { lastError: "retryable", releasedAt: 20 });
      const finalClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!finalClaim) {
        throw new Error("Expected a reclaimed ingress event");
      }
      await queue.fail(finalClaim, { reason: "handler-error", message: "fatal", failedAt: 30 });

      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        {
          id: "event-1",
          channelId: "telegram",
          accountId: "ops",
          queueName: JSON.stringify(["telegram", "ops"]),
          payload: { text: "recover me" },
          metadata: { source: "webhook" },
          receivedAt: 5,
          updatedAt: 30,
          laneKey: "chat-1",
          attempts: 1,
          lastAttemptAt: 20,
          failedAt: 30,
          reason: "handler-error",
          message: "fatal",
        },
      ]);
    });
  });

  it("resubmits a failed event exactly once and refuses its completed tombstone", async () => {
    await withIsolatedState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }, { source: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      });
      if (!queue.resubmit) {
        throw new Error("Expected queue.resubmit");
      }

      await queue.enqueue(
        "event-1",
        { text: "once" },
        { metadata: { source: "webhook" }, receivedAt: 10, laneKey: "chat-1" },
      );
      const originalClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!originalClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(originalClaim, { reason: "handler-error", failedAt: 20 });

      await expect(queue.resubmit("event-1", { resubmittedAt: 30 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: {
          id: "event-1",
          payload: { text: "once" },
          metadata: { source: "webhook" },
          receivedAt: 30,
          laneKey: "chat-1",
          attempts: 0,
        },
        previous: { attempts: 0, failedAt: 20, reason: "handler-error" },
      });
      await expect(queue.resubmit("event-1", { resubmittedAt: 31 })).resolves.toEqual({
        kind: "active",
        status: "pending",
      });

      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "once" } });
      await expect(queue.claimNext({ ownerId: "other-worker" })).resolves.toBeNull();
      if (!replay) {
        throw new Error("Expected the resubmitted event to be claimable");
      }
      expect(await queue.complete(replay, { completedAt: 40 })).toBe(true);
      await expect(queue.resubmit("event-1", { resubmittedAt: 50 })).resolves.toMatchObject({
        kind: "completed",
        record: { id: "event-1", completedAt: 40 },
      });
      await expect(queue.claimNext()).resolves.toBeNull();
    });
  });

  it("retains and resubmits a valid null payload", async () => {
    await withIsolatedState(async (stateDir) => {
      const queue = createChannelIngressQueue<null>({
        channelId: "telegram",
        accountId: "null-payload",
        stateDir,
      });
      if (!queue.resubmit) {
        throw new Error("Expected queue.resubmit");
      }

      await queue.enqueue("event-null", null);
      const claim = await queue.claim("event-null", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });

      await expect(queue.listFailed?.()).resolves.toEqual([
        expect.objectContaining({ id: "event-null", payload: null }),
      ]);
      await expect(queue.resubmit("event-null", { resubmittedAt: 30 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: { id: "event-null", payload: null, attempts: 0 },
      });
      await expect(queue.claimNext({ ownerId: "replay-worker" })).resolves.toMatchObject({
        id: "event-null",
        payload: null,
      });
    });
  });

  it("counts dead letters by channel account with their oldest failure", async () => {
    await withIsolatedState(async (stateDir) => {
      const telegram = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });
      const line = createChannelIngressQueue<{ text: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      });
      for (const [queue, id, failedAt] of [
        [telegram, "tg-1", 20],
        [telegram, "tg-2", 30],
        [line, "line-1", 40],
      ] as const) {
        await queue.enqueue(id, { text: id });
        const claim = await queue.claim(id, { ownerId: "worker" });
        if (!claim) {
          throw new Error(`Expected ${id} to be claimed`);
        }
        await queue.fail(claim, { reason: "handler-error", failedAt });
      }
      const { db } = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      db.prepare(
        "UPDATE channel_ingress_events SET failed_at = NULL WHERE channel_id = 'line'",
      ).run();

      expect(await countFailedChannelIngressQueueEntries(stateDir)).toEqual([
        { channelId: "line", accountId: "default", count: 1 },
        { channelId: "telegram", accountId: "ops", count: 2, oldestFailedAt: 20 },
      ]);
    });
  });
});

describe("ingress listing access", () => {
  it("lists without creating the shared state database", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-ingress-readonly-", applyEnv: false },
      async ({ stateDir, statePath }) => {
        const sqlitePath = statePath("state", "openclaw.sqlite");
        await expect(fs.access(sqlitePath)).rejects.toThrow();

        const reader = createChannelIngressQueue<{ text: string }>({
          channelId: "line",
          accountId: "default",
          stateDir,
          access: "read-only",
        });
        // The read-only opener never creates, migrates or configures the file, so a
        // caller that runs before it owns the state cannot bring the store into being.
        // Account discovery runs before the inspection facade is even opened, so it is
        // the first thing that could create the store.
        expect(
          await listChannelIngressQueueAccountIdsReadOnly({ channelId: "line", stateDir }),
        ).toEqual([]);
        await expect(fs.access(sqlitePath)).rejects.toThrow();

        expect(await reader.listPending({ limit: "all" })).toEqual([]);
        expect(await reader.listClaims()).toEqual([]);
        expect(await reader.listFailed?.({ limit: "all" })).toEqual([]);
        await expect(fs.access(sqlitePath)).rejects.toThrow();

        // A read-write queue is what actually creates it, and the read-only reader then
        // sees the same rows - so the empty results above are the access mode, not a
        // broken reader.
        await createChannelIngressQueue<{ text: string }>({
          channelId: "line",
          accountId: "default",
          stateDir,
        }).enqueue("evt-1", { text: "hello" });
        await fs.access(sqlitePath);
        await closeOpenClawStateDatabaseByPathAsync(sqlitePath);

        const after = createChannelIngressQueue<{ text: string }>({
          channelId: "line",
          accountId: "default",
          stateDir,
          access: "read-only",
        });
        const hostQueries = vi
          .spyOn(sqliteQueries, "executeSqliteQuerySync")
          .mockImplementation(() => {
            throw new Error("Ingress inspection must not query SQLite on the calling thread");
          });
        try {
          expect((await after.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
            "evt-1",
          ]);
          expect(
            await listChannelIngressQueueAccountIdsReadOnly({ channelId: "line", stateDir }),
          ).toEqual(["default"]);
          expect(hostQueries).not.toHaveBeenCalled();
        } finally {
          hostQueries.mockRestore();
        }
      },
    );
  });

  it("observes committed writes inside an older ambient read snapshot", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-ingress-list-committed-", applyEnv: false },
      async ({ stateDir, statePath }) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "line",
          accountId: "default",
          stateDir,
        });
        await queue.enqueue("before", { text: "before" }, { receivedAt: 1 });
        await withOpenClawStateDatabaseReadSnapshot(
          async () => {
            await queue.enqueue("after", { text: "after" }, { receivedAt: 2 });
            expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
              "before",
              "after",
            ]);
          },
          {
            path: statePath("state", "openclaw.sqlite"),
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          },
        );
      },
    );
  });
});
