import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { executePluginStateOperation } from "./plugin-state-operation.kernel.js";
import { selectPluginStateEntry, upsertPluginStateEntry } from "./plugin-state-store.kernel.js";

it("refuses NUL plugin keys before PostgreSQL reads or writes", () => {
  const db = new DatabaseSync(":memory:");
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
  try {
    const scope = { pluginId: "test", namespace: "test", key: "nul\0tail" };
    for (const run of [
      () => selectPluginStateEntry(db, { ...scope, now: 1 }),
      () =>
        upsertPluginStateEntry(db, {
          plugin_id: scope.pluginId,
          namespace: scope.namespace,
          entry_key: scope.key,
          value_json: "{}",
          created_at: 1,
          expires_at: null,
        }),
    ]) {
      expect(run).toThrow(
        expect.objectContaining({
          code: "PLUGIN_STATE_INVALID_INPUT",
          message: "PostgreSQL plugin state keys cannot contain NUL characters.",
        }),
      );
    }
  } finally {
    db.close();
  }
});

it.each([
  { scanned: false, expiredCount: 1, probes: 0 },
  { scanned: true, expiredCount: 1, probes: 1 },
  { scanned: false, expiredCount: 1_025, probes: 1 },
])(
  "preserves cleanup, capacity, and read-own-write ($scanned, $expiredCount expired)",
  ({ scanned, expiredCount, probes }) => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE plugin_state_entries (
    plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
    value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
    PRIMARY KEY (plugin_id, namespace, entry_key)
  ) STRICT;
  INSERT INTO plugin_state_entries VALUES
    ('fixture', 'bounded', 'live', '1', 1, NULL),
    ('fixture', 'bounded', 'removed', '2', 2, NULL),
    ('fixture', 'bounded', 'expired', '3', 3, 1);`);
    const insert = db.prepare(
      "INSERT INTO plugin_state_entries VALUES ('fixture', 'bounded', ?, '0', 3, 1)",
    );
    for (let index = 1; index < expiredCount; index++) {
      insert.run(`expired-${index}`);
    }
    const scope = {
      pluginId: "fixture",
      namespace: "bounded",
      maxEntries: 2,
      overflowPolicy: "reject-new" as const,
    };
    const input = {
      module: {
        modulePath: import.meta.filename,
        boundaryRoot: import.meta.dirname,
        origin: "bundled" as const,
        pluginId: "fixture",
      },
      exportName: "fixture",
      stores: [scope],
      writeStores: [0],
      command: { type: "fixture", input: null },
      receiptId: "fixture",
    };
    const counter = trackSqliteStatementExecutions(db, ["aggregate", "probe", "delete"], (sql) => {
      if (sql.startsWith("select sum(")) {
        return "aggregate";
      }
      if (sql.startsWith('select "expires_at"')) {
        return "probe";
      }
      if (sql.startsWith("delete from")) {
        return "delete";
      }
      return null;
    });
    try {
      const result = runSqliteImmediateTransactionSync(db, () =>
        executePluginStateOperation({ db, path: ":memory:" }, input, (_command, tx) => {
          if (scanned) {
            tx.entries(0);
          }
          tx.delete(0, "removed");
          tx.set(0, "live", 4);
          tx.set(0, "new", 5);
          return tx.entries(0);
        }),
      );
      expect(result.value).toEqual([
        expect.objectContaining({ key: "live", value: 4 }),
        expect.objectContaining({ key: "new", value: 5 }),
      ]);
      expect(counter.counts).toEqual({
        aggregate: scanned ? 0 : 1,
        probe: probes,
        delete: expiredCount > 1_024 ? 3 : 2,
      });
      expect(
        db.prepare("SELECT entry_key FROM plugin_state_entries ORDER BY entry_key").all(),
      ).toEqual([{ entry_key: "live" }, { entry_key: "new" }]);
      expect(() =>
        runSqliteImmediateTransactionSync(db, () =>
          executePluginStateOperation({ db, path: ":memory:" }, input, (_command, tx) => {
            tx.set(0, "over-capacity", 6);
          }),
        ),
      ).toThrow(/reached its 2-row limit/);
    } finally {
      counter.restore();
      db.close();
    }
  },
);
