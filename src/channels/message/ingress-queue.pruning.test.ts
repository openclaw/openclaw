// Pruning keeps durable ingress retention bounded without loading retained rows.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";
import { pruneChannelIngressInDatabase } from "./ingress-queue.kernel.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

describe("channel ingress pruning", () => {
  it("does not create a database when no retention work is requested", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      expect(await queue.prune({ protectIds: ["retained"] })).toBe(0);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    });
  });

  it("captures protected ids before worker preparation yields", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });
      await queue.enqueue("a", { text: "retained" });
      await queue.enqueue("z", { text: "expired" });
      const protectIds = new Set([" a ", ""]);
      const pruning = queue.prune({ pendingMaxEntries: 0, protectIds });
      protectIds.clear();
      expect(await pruning).toBe(1);
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["a"]);
    });
  });

  it("can bound pending scans and prune stale pending rows", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock++ });

      await queue.enqueue("0002", { text: "second" });
      await queue.enqueue("0001", { text: "first" });
      await queue.enqueue("0003", { text: "third" });

      expect(
        (await queue.listPending({ limit: 2, orderBy: "id" })).map((record) => record.id),
      ).toEqual(["0001", "0002"]);
      expect(await queue.prune({ pendingTtlMs: 3, pendingMaxEntries: 1, now: 7 })).toBe(2);
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "0003",
      ]);
    });
  });

  it.each([
    { ids: ["z", "a"], max: 1, protected: [" a ", "", "   "], retained: ["a", "z"] },
    {
      ids: ["a", "z", "\ufffd", "keep\u0000key", "keep\\u0000key"],
      max: 0,
      protected: [" a ", "\ud800", "keep\u0000key"],
      retained: ["a", "keep\u0000key"],
    },
  ])("preserves protected IDs and their retention slots: $max", async (fixture) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      for (const id of fixture.ids) {
        await queue.enqueue(id, { text: id });
      }

      expect(
        await queue.prune({ pendingMaxEntries: fixture.max, protectIds: fixture.protected }),
      ).toBe(fixture.ids.length - fixture.retained.length);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(fixture.retained);
    });
  });

  it.each(["pending", "completed", "failed"] as const)(
    "prunes %s overflow without materializing rows",
    async (status) => {
      await withTempState(async (stateDir) => {
        const env = { OPENCLAW_STATE_DIR: stateDir };
        const { db } = openOpenClawStateDatabase({ env });
        const queueName = JSON.stringify(["test", "a"]);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
            .insertInto("channel_ingress_events")
            .values(
              Array.from({ length: 520 }, (_, index) => ({
                queue_name: queueName,
                event_id: String(index).padStart(4, "0"),
                channel_id: "test",
                account_id: "a",
                status,
                payload_json: JSON.stringify({ text: String(index) }),
                received_at: index,
                updated_at: index,
              })),
            ),
        );
        const queries = trackSqliteStatementExecutions(db, ["prune"], (sql) =>
          sql.includes('"channel_ingress_events"') ? "prune" : null,
        );
        try {
          const options = { [`${status}MaxEntries`]: 2 };
          // Instrument the worker-owned kernel's native row materialization.
          const prune = () =>
            runOpenClawStateWriteTransaction(
              (tx) => pruneChannelIngressInDatabase(tx.db, { queueName, options, now: 600 }),
              { env },
            );
          expect(prune()).toBe(518);
          expect(queries.rowCounts.prune).toBe(0);
          expect(queries.counts.prune).toBeLessThanOrEqual(3);
          expect(prune()).toBe(0);
          expect(queries.rowCounts.prune).toBe(0);
          expect(queries.counts.prune).toBeLessThanOrEqual(4);
        } finally {
          queries.restore();
        }
        expect(
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
              .selectFrom("channel_ingress_events")
              .select("event_id")
              .orderBy("event_id", "asc"),
          ).rows.map((row) => row.event_id),
        ).toEqual(["0518", "0519"]);
      });
    },
  );
});
