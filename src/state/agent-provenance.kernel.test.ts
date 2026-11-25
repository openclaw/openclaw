import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { readAgentProvenanceBatchInDatabase } from "./agent-provenance.kernel.js";

function withProvenance(run: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  try {
    // Allow malformed retained rows so decoding and native SQLite errors can be compared.
    db.exec(`CREATE TABLE agent_provenance (
      agent_id TEXT PRIMARY KEY,
      created_via TEXT NOT NULL,
      creator_agent_id TEXT,
      created_at_ms INTEGER NOT NULL
    ) STRICT`);
    run(db);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}

describe("configured agent provenance batching", () => {
  it("keeps requested order, normalized aliases, missing rows, and duplicates in one read", () => {
    withProvenance((db) => {
      const insert = db.prepare("INSERT INTO agent_provenance VALUES (?, ?, ?, ?)");
      const ids = Array.from({ length: 128 }, (_, index) => `worker-${127 - index}`);
      for (const [index, id] of ids.entries()) {
        insert.run(id, "agent", "main", index);
      }
      insert.run("main", "operator", null, 1);
      insert.run("unrelated", "invalid", null, 9007199254740992n);
      const requested = [" Main ", "missing", ...ids, "MAIN"];
      const main = {
        agentId: "main",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 1,
      };
      const expected = [
        main,
        ...ids.map((agentId, createdAtMs) => ({
          agentId,
          createdVia: "agent",
          creatorAgentId: "main",
          createdAtMs,
        })),
        main,
      ];
      const counter = trackSqliteStatementExecutions(db, ["provenance"], (sql) =>
        sql.includes('"agent_provenance"') ? "provenance" : null,
      );
      try {
        expect(readAgentProvenanceBatchInDatabase(db, requested)).toEqual(expected);
        expect(counter.counts.provenance).toBe(1);
        expect(counter.rowCounts.provenance).toBe(expected.length);
      } finally {
        counter.restore();
      }
    });
  });

  it.each([
    ["bad-enum", "bad-integer"],
    ["bad-integer", "bad-enum"],
  ])("reports the first requested corruption for %s before %s", (first, second) => {
    withProvenance((db) => {
      const insert = db.prepare("INSERT INTO agent_provenance VALUES (?, ?, ?, ?)");
      insert.run("bad-enum", "invalid", null, 1);
      insert.run("bad-integer", "operator", null, 9007199254740992n);
      const ids = ["missing", first, second];
      let expectedError: unknown = new Error("Invalid agent provenance created_via: invalid");
      if (first === "bad-integer") {
        expectedError = undefined;
        try {
          db.prepare("SELECT * FROM agent_provenance WHERE agent_id = ?").get(first);
        } catch (error) {
          expectedError = error;
        }
        if (!(expectedError instanceof Error)) {
          throw new Error("Expected native provenance read to reject an unsafe integer");
        }
      }
      expect(() => readAgentProvenanceBatchInDatabase(db, ids)).toThrow(expectedError);
      // The iterator must release its statement when the row codec throws.
      db.exec("DELETE FROM agent_provenance");
      expect(readAgentProvenanceBatchInDatabase(db, ids)).toEqual([]);
    });
  });
});
