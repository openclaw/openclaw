// Pruning keeps durable ingress retention bounded without loading retained rows.
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
  it("preserves protected IDs and their retention slots", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      for (const id of ["z", "a"]) {
        await queue.enqueue(id, { text: id });
      }

      expect(await queue.prune({ pendingMaxEntries: 1, protectIds: [" a ", "", "   "] })).toBe(0);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(["a", "z"]);
    });
  });

  it("prunes pending overflow past a protected page without materializing rows", async () => {
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
              status: "pending",
              payload_json: JSON.stringify({ text: String(index) }),
              received_at: index,
              updated_at: index,
            })),
          ),
      );
      const protectedIds = Array.from({ length: 500 }, (_, index) =>
        String(index + 18).padStart(4, "0"),
      );
      const queries = trackSqliteStatementExecutions(db, ["prune"], (sql) =>
        sql.includes('"channel_ingress_events"') ? "prune" : null,
      );
      try {
        const options = { pendingMaxEntries: 2, protectIds: protectedIds };
        // Instrument the worker-owned kernel's native row materialization.
        const prune = () =>
          runOpenClawStateWriteTransaction(
            (tx) => pruneChannelIngressInDatabase(tx.db, { queueName, options, now: 600 }),
            { env },
          );
        expect(prune()).toBe(18);
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
      ).toEqual([...protectedIds, "0518", "0519"]);
    });
  });
});
