import { describe, expect, it, vi } from "vitest";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadDeliveryQueueEntryInDatabase as loadEntry } from "../delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase as complete,
  prepareDeliveryQueueTerminalEntry as prepareTerminal,
  pruneExpiredDeliveryQueueTombstonesInDatabase as prune,
  terminalizePendingDeliveryQueueEntryInDatabase as terminalize,
  upsertDeliveryQueueEntryInDatabase as upsert,
} from "../delivery-queue-sqlite.kernel.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { runSqliteImmediateTransactionSync as transaction } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const QUEUE = "retention-conformance";
const NOW = 4_000_000_000;
const ORDINARY_AGE = 30 * 86_400_000;
const retention = (idPrefix: string, maxAgeMs: number) => ({ idPrefix, maxAgeMs, maxEntries: 10 });
const entry = (id: string, enqueuedAt = NOW, maxAgeMs?: number) => ({
  id,
  enqueuedAt,
  retryCount: 0,
  ...(maxAgeMs === undefined
    ? {}
    : {
        recoveryState: "completed_bounded" as const,
        completionRetention: retention("bounded-", maxAgeMs),
      }),
});

function pruneAt(database: OpenClawStateDatabase, time = NOW) {
  vi.mocked(Date.now).mockReturnValue(time);
  prune(database);
}

const contracts: Record<string, (database: OpenClawStateDatabase) => void> = {
  "prunes bounded completions by count and age without pruning another queue": (database) => {
    const completionRetention = { idPrefix: "completion-", maxAgeMs: 60_000, maxEntries: 2 };
    const completeReceipt = (suffix: string, queueName = QUEUE) => {
      const id = `${completionRetention.idPrefix}${suffix}`;
      transaction(database.db, () => {
        upsert({ queueName, entry: { ...entry(id, Date.now()), completionRetention } }, database);
        complete(database, queueName, id);
      });
      return id;
    };
    const sibling = completeReceipt("sibling", "another-queue");
    const first = completeReceipt("a");
    const second = completeReceipt("b");
    const third = completeReceipt("c");
    expect(loadEntry(database, QUEUE, first)).toBeNull();
    expect(loadEntry(database, QUEUE, second)).not.toBeNull();
    expect(loadEntry(database, QUEUE, third)).not.toBeNull();

    vi.mocked(Date.now).mockReturnValue(NOW + completionRetention.maxAgeMs + 1);
    const newest = completeReceipt("d");
    expect(loadEntry(database, QUEUE, second)).toBeNull();
    expect(loadEntry(database, QUEUE, third)).toBeNull();
    expect(loadEntry(database, QUEUE, newest)).not.toBeNull();
    expect(loadEntry(database, "another-queue", sibling)).not.toBeNull();
  },
  "orders mixed receipt deadlines and preserves large bounded ages": (database) => {
    transaction(database.db, () => {
      for (const receipt of [
        entry("ordinary", NOW - ORDINARY_AGE + 10),
        entry("bounded-sooner", NOW - 100, 105),
        entry("bounded-huge", NOW, Number.MAX_SAFE_INTEGER),
      ]) {
        upsert({ queueName: QUEUE, status: "completed", entry: receipt }, database);
      }
    });
    pruneAt(database);
    pruneAt(database, NOW + 6);
    expect(loadEntry(database, QUEUE, "bounded-sooner")).toBeNull();
    expect(loadEntry(database, QUEUE, "ordinary")).not.toBeNull();
    pruneAt(database, NOW + 10);
    expect(loadEntry(database, QUEUE, "ordinary")).not.toBeNull();
    pruneAt(database, NOW + 11);
    expect(loadEntry(database, QUEUE, "ordinary")).toBeNull();
    expect(loadEntry(database, QUEUE, "bounded-huge")).not.toBeNull();
    prune(database);
    expect(loadEntry(database, QUEUE, "bounded-huge")).not.toBeNull();
  },
  "expires a new terminal receipt after an empty inventory at its exact boundary": (database) => {
    prune(database);
    const receipt = {
      ...entry("terminal-bounded"),
      completionRetention: retention("terminal-", 60_000),
    };
    transaction(database.db, () => upsert({ queueName: QUEUE, entry: receipt }, database));
    expect(
      transaction(database.db, () =>
        terminalize(
          database,
          prepareTerminal({ queueName: QUEUE, id: receipt.id, entry: receipt }),
        ),
      ),
    ).toEqual({ status: "terminalized", retained: true });
    pruneAt(database, NOW + 60_000);
    expect(loadEntry(database, QUEUE, receipt.id)).not.toBeNull();
    pruneAt(database, NOW + 60_001);
    expect(loadEntry(database, QUEUE, receipt.id)).toBeNull();
  },
  "discards an empty expiry published by rolled-back pruning": (database) => {
    const receipt = entry("rollback", NOW - ORDINARY_AGE - 1);
    transaction(database.db, () =>
      upsert({ queueName: QUEUE, entry: receipt, status: "completed" }, database),
    );
    expect(() =>
      transaction(database.db, () => {
        prune(database);
        prune(database);
        throw new Error("rollback retention");
      }),
    ).toThrow("rollback retention");
    expect(loadEntry(database, QUEUE, receipt.id)).not.toBeNull();
    prune(database);
    expect(loadEntry(database, QUEUE, receipt.id)).toBeNull();
  },
};

describe.skipIf(!mixedAgentConnection).each(Object.entries(contracts))(
  "PostgreSQL retention: %s",
  (_name, check) => {
    useMixedAgentPair("postgres", "sqlite");

    it("preserves the delivery queue retention contract", () => {
      withEngineStoreAdmission(() => {
        const database = openOpenClawStateDatabase();
        expect(isPostgresSqlConnection(database.db)).toBe(true);
        const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
        try {
          check(database);
        } finally {
          now.mockRestore();
        }
      });
    });
  },
);
