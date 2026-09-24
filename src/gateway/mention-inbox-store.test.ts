import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { MentionStoreSource } from "./mention-inbox-store.codec.js";
import {
  readMentionStoreSnapshotInDatabase,
  writeMentionStoreChanges,
} from "./mention-inbox-store.js";

it("deletes an expiry cohort with bounded SQL while retaining unrelated sources", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `CREATE TABLE config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT`,
    );
    const sources = new Map<string, MentionStoreSource>();
    for (let index = 0; index < 33; index++) {
      const key = createHash("sha256").update(`expired-source-${index}`).digest("hex");
      sources.set(key, { key, sequence: index, expiresAt: 1, recipients: [["bob", null]] });
    }
    const head = runSqliteImmediateTransactionSync(db, () =>
      writeMentionStoreChanges(db, { revision: 0, nextSequence: 33 }, sources),
    );
    const retained = [...sources.values()].at(-1)!;
    const expired = new Map([...sources.keys()].slice(0, 32).map((key) => [key, undefined]));
    const counter = trackSqliteStatementExecutions(db, ["delete"], (sql) =>
      /^delete from "config_machine_state"/i.test(sql) ? "delete" : null,
    );
    try {
      runSqliteImmediateTransactionSync(db, () => writeMentionStoreChanges(db, head, expired));
      // A positive lower bound prevents the former worker-blind assertion from passing.
      expect(counter.counts.delete).toBeGreaterThan(0);
      expect(counter.counts.delete).toBeLessThanOrEqual(2);
    } finally {
      counter.restore();
    }
    expect(readMentionStoreSnapshotInDatabase(-1, db)).toEqual({
      head: { revision: head.revision + 1, nextSequence: 33 },
      sources: [retained],
    });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
});
