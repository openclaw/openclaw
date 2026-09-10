import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { migrateSupervisedAttemptAllocationsV18 } from "./openclaw-state-db-schema-v18-attempts.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS task_flow_workspace_allocations (",
  );
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(") STRICT;", start);
  const legacy = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 9).replace(
    "REFERENCES task_flow_episodes(flow_id, episode)",
    "REFERENCES task_flow_contracts(flow_id, episode)",
  );
  db.exec(
    OPENCLAW_STATE_SCHEMA_SQL.slice(0, start) + legacy + OPENCLAW_STATE_SCHEMA_SQL.slice(end + 9),
  );
  db.exec(
    "INSERT INTO task_flow_episodes VALUES ('owner',1,0,'ready',1,5000,'{}'); INSERT INTO task_flow_contracts VALUES ('owner',1,'hash','/fixture','{}');",
  );
  db.exec(
    "INSERT INTO task_flow_workspace_allocations (allocation_id,flow_id,episode,owner_kind,owner_id,owner_pid,owner_start_time,kind,state,reserved_bytes,retention_ms,discardable_at_ms,created_at_ms,updated_at_ms) VALUES ('kept','owner',1,'attempt','attempt-1',123,10,'draft','reserved',67108864,86400000,NULL,100,100);",
  );
  return db;
}
it("preserves allocation bytes, identity, references and indexes while enabling workflowless drafts", () => {
  const db = fixture();
  const before = db.prepare("SELECT * FROM task_flow_workspace_allocations").all();
  db.exec("BEGIN IMMEDIATE");
  expect(migrateSupervisedAttemptAllocationsV18(db, 17)).toBe(true);
  db.exec("COMMIT; PRAGMA foreign_keys=ON");
  expect(db.prepare("SELECT * FROM task_flow_workspace_allocations").all()).toEqual(before);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  db.exec("DELETE FROM task_flow_contracts WHERE flow_id='owner'");
  expect(
    db.prepare("SELECT allocation_id FROM task_flow_workspace_allocations").all(),
  ).toHaveLength(1);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_task_flow_workspace_allocations_%'",
      )
      .all(),
  ).toHaveLength(2);
  expect(migrateSupervisedAttemptAllocationsV18(db, 17)).toBe(false);
});
it("does not create feature tables in a database that has never used supervision", () => {
  const db = new DatabaseSync(":memory:");
  opened.push(db);
  expect(migrateSupervisedAttemptAllocationsV18(db, 17)).toBe(false);
  expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
});
it("preserves evidence and refuses unrecognized attached objects", () => {
  const db = fixture();
  db.exec("CREATE INDEX foreign_owner_index ON task_flow_workspace_allocations(owner_id)");
  const before = db.prepare("SELECT * FROM task_flow_workspace_allocations").all();
  expect(() => migrateSupervisedAttemptAllocationsV18(db, 17)).toThrow(/unsupported attached/);
  expect(db.prepare("SELECT * FROM task_flow_workspace_allocations").all()).toEqual(before);
});
