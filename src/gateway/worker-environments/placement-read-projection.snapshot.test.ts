import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as sqlite from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readWorkerSessionPlacementProjectionInDatabase } from "./placement-read-projection.js";

function seedPlacements() {
  const database = openOpenClawStateDatabase();
  const insert = database.db.prepare(`INSERT INTO worker_session_placements
    (session_id, agent_id, session_key, state, created_at_ms, updated_at_ms, state_changed_at_ms)
    VALUES (?, 'main', ?, 'local', 0, 0, 0)`);
  for (const id of ["first", "last"]) {
    insert.run(id, `agent:main:${id}`);
  }
  return database;
}

it.each([1, 250])("reads a %s-id placement projection with one SQLite statement", async (size) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { db } = seedPlacements();
    const ids = ["first", ...Array.from({ length: size - 1 }, (_, i) => `absent-${i}`)];
    readWorkerSessionPlacementProjectionInDatabase(db, ids, []);
    const sql = trackSqliteStatementExecutions(db, ["projection"], () => "projection");
    const exec = vi.spyOn(db, "exec");
    try {
      const { projection } = readWorkerSessionPlacementProjectionInDatabase(db, ids, []);
      expect([...projection.placements.keys()]).toEqual(["first"]);
      expect(sql.counts.projection).toBe(1);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
      sql.restore();
    }
  });
});

it("keeps one placement snapshot across chunks when another connection commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = seedPlacements();
    const { DatabaseSync } = requireNodeSqlite();
    const foreign = new DatabaseSync(database.path);
    const ids = ["first", ...Array.from({ length: 249 }, (_, i) => `absent-${i}`), "last"];
    const execute = sqlite.executeSqliteQuerySync;
    let committed = false;
    const reads = vi.spyOn(sqlite, "executeSqliteQuerySync").mockImplementation((...args) => {
      const result = execute(...args);
      if (args[0] === database.db && !committed) {
        committed = true;
        foreign
          .prepare(
            "UPDATE worker_session_placements SET transition_generation = 1 WHERE session_id = ?",
          )
          .run("last");
      }
      return result;
    });
    try {
      const { projection } = readWorkerSessionPlacementProjectionInDatabase(database.db, ids, []);
      expect(committed).toBe(true);
      expect(projection.placements.get("first")?.generation).toBe(0);
      expect(projection.placements.get("last")?.generation).toBe(0);
    } finally {
      reads.mockRestore();
      foreign.close();
    }
    expect(
      readWorkerSessionPlacementProjectionInDatabase(
        database.db,
        ["last"],
        [],
      ).projection.placements.get("last")?.generation,
    ).toBe(1);
  });
});
