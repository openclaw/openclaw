import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadDeliveryQueueEntryInDatabase as loadEntry } from "../delivery-queue-sqlite-bound.js";
import {
  pruneExpiredDeliveryQueueTombstonesInDatabase as prune,
  upsertDeliveryQueueEntryInDatabase as upsert,
} from "../delivery-queue-sqlite.kernel.js";
import { runSqliteImmediateTransactionSync as transaction } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL receipt deadlines", () => {
  useMixedAgentPair("postgres", "sqlite");
  it("orders mixed receipt deadlines and preserves large bounded ages", () =>
    withEngineStoreAdmission(() => {
      const database = openOpenClawStateDatabase();
      const queueName = "retention-conformance";
      const nowMs = 4_000_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(nowMs);
      const entry = (id: string, enqueuedAt: number, maxAgeMs?: number) => ({
        id,
        enqueuedAt,
        retryCount: 0,
        ...(maxAgeMs === undefined
          ? {}
          : {
              recoveryState: "completed_bounded" as const,
              completionRetention: { idPrefix: "bounded-", maxAgeMs, maxEntries: 10 },
            }),
      });
      const pruneAt = (offset = 0) => {
        now.mockReturnValue(nowMs + offset);
        prune(database);
      };
      const load = (id: string) => loadEntry(database, queueName, id);
      try {
        transaction(database.db, () => {
          for (const receipt of [
            entry("ordinary", nowMs - 30 * 86_400_000 + 10),
            entry("bounded-sooner", nowMs - 100, 105),
            entry("bounded-huge", nowMs, Number.MAX_SAFE_INTEGER),
          ]) {
            upsert({ queueName, status: "completed", entry: receipt }, database);
          }
        });
        pruneAt();
        pruneAt(6);
        expect(load("bounded-sooner")).toBeNull();
        expect(load("ordinary")).not.toBeNull();
        pruneAt(10);
        expect(load("ordinary")).not.toBeNull();
        pruneAt(11);
        expect(load("ordinary")).toBeNull();
        expect(load("bounded-huge")).not.toBeNull();
        prune(database);
        expect(load("bounded-huge")).not.toBeNull();
      } finally {
        now.mockRestore();
      }
    }));
});
