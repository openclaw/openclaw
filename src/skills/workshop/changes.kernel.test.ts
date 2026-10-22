import { describe, expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listWorkshopChangesInDatabase,
  recordWorkshopChangeInDatabase,
  type WorkshopChange,
} from "./changes.kernel.js";

const change = (id: string, createdAtMs: number): WorkshopChange => ({
  id,
  agentId: "main",
  skillName: "deploy",
  action: "patch",
  actor: "agent",
  summary: id,
  createdAtMs,
});

describe("workshop change storage", () => {
  it("orders timestamp ties by the portable cursor and reuses a deleted maximum", async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    try {
      const database = openOpenClawStateDatabase();
      const { db } = database;
      for (const id of ["first", "second"]) {
        runSqliteImmediateTransactionSync(db, () =>
          recordWorkshopChangeInDatabase(database, change(id, 1)),
        );
      }
      db.exec("UPDATE skill_workshop_changes SET rowid = 100 WHERE change_id = 'first'");
      expect(listWorkshopChangesInDatabase(db, { agentId: "main", limit: 2 })).toEqual([
        change("second", 1),
        change("first", 1),
      ]);
      db.exec("DELETE FROM skill_workshop_changes WHERE change_id = 'second'");
      runSqliteImmediateTransactionSync(db, () =>
        recordWorkshopChangeInDatabase(database, change("third", 1)),
      );
      expect(listWorkshopChangesInDatabase(db, { agentId: "main", limit: 2 })).toEqual([
        change("third", 1),
        change("first", 1),
      ]);
      expect(
        db.prepare("SELECT cursor_id FROM skill_workshop_changes WHERE change_id = 'third'").get(),
      ).toEqual({ cursor_id: 2 });
    } finally {
      await state.cleanup();
    }
  });

  it("retains committed changes after a failed first append and reuses admitted schema", async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    try {
      const database = openOpenClawStateDatabase();
      const { db } = database;
      db.exec("DROP TABLE IF EXISTS skill_workshop_changes");
      expect(listWorkshopChangesInDatabase(db, { agentId: "main", limit: 10 })).toEqual([]);
      expect(() =>
        runSqliteImmediateTransactionSync(db, () => {
          recordWorkshopChangeInDatabase(database, change("rolled-back", 1));
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(listWorkshopChangesInDatabase(db, { agentId: "main", limit: 10 })).toEqual([]);

      runSqliteImmediateTransactionSync(db, () =>
        recordWorkshopChangeInDatabase(database, change("first", 2)),
      );
      const exec = vi.spyOn(db, "exec");
      try {
        runSqliteImmediateTransactionSync(db, () =>
          recordWorkshopChangeInDatabase(database, change("second", 3)),
        );
        expect(listWorkshopChangesInDatabase(db, { agentId: "main", limit: 10 })).toEqual([
          change("second", 3),
          change("first", 2),
        ]);
        expect(exec.mock.calls.filter(([sql]) => /CREATE\s+(?:TABLE|INDEX)/iu.test(sql))).toEqual(
          [],
        );
      } finally {
        exec.mockRestore();
      }
    } finally {
      await state.cleanup();
    }
  });
});
