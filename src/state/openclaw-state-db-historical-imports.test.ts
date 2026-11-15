import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  seedHistoricalPlacements,
  stateV21Schema,
} from "./openclaw-historical-imports.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);

function snapshot(db: DatabaseSync) {
  return {
    placements: db
      .prepare("SELECT rowid,* FROM worker_session_placements ORDER BY session_id")
      .all(),
    dependentCustody: db.prepare("SELECT * FROM historical_cleanup_custody").all(),
    leases: db.prepare("SELECT * FROM state_leases WHERE scope='fixture'").all(),
  };
}

it.each([
  ["refuses a live worker claim without losing historical custody", "claim"],
  ["rolls back publication failure and retries without losing historical custody", "publication"],
] as const)("%s", async (_name, refusal) => {
  const root = dirs.make("historical-placement-");
  const pathname = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const options = {
    path: pathname,
    env: { OPENCLAW_STATE_DIR: root },
    versionMigrationOnly: true,
  };
  using db = new DatabaseSync(pathname);
  db.exec(stateV21Schema());
  db.exec(
    "PRAGMA user_version=21; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',21,1,1);",
  );
  seedHistoricalPlacements(db);
  db.exec(
    "CREATE TABLE historical_cleanup_custody (session_id TEXT PRIMARY KEY REFERENCES worker_session_placements(session_id) ON DELETE CASCADE, evidence TEXT NOT NULL); INSERT INTO historical_cleanup_custody VALUES ('placement-pending',' {\"custody\": 7} ');" +
      "INSERT INTO state_leases VALUES ('fixture','custody','fixture-owner',1900000000000,11,' {\"lease\": 7} ',1,2);",
  );
  db.exec(
    refusal === "claim"
      ? "UPDATE worker_session_placements SET turn_claim_owner='worker',turn_claim_id='pending-claim',turn_claim_run_id='pending-run',turn_claim_generation=7,turn_claim_owner_epoch=3 WHERE session_id='placement-pending'"
      : "CREATE TRIGGER refuse_publication BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT,'fixture publication refusal'); END;",
  );
  await withStateMigrationBackupForTest(options, () => {
    const before = snapshot(db);
    const shape = db
      .prepare("SELECT sql FROM sqlite_schema WHERE name='worker_session_placements'")
      .get();
    expect(repairOpenClawStateDatabaseSchema(options).warnings.join("\n")).toContain(
      refusal === "claim" ? "retains a worker turn claim" : "fixture publication refusal",
    );
    expect(snapshot(db)).toEqual(before);
    expect(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='worker_session_placements'").get(),
    ).toEqual(shape);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
    expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(21);
    if (refusal === "publication") {
      db.exec("DROP TRIGGER refuse_publication");
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      const after = snapshot(db);
      expect(after).toEqual({ ...before, placements: expect.any(Array) });
      expect(after.placements).toHaveLength(before.placements.length);
      for (const [index, row] of before.placements.entries()) {
        expect(after.placements[index]).toEqual(
          row.repository_preparation === "pending"
            ? {
                ...row,
                state: "failed",
                recovery_error: expect.stringContaining(
                  "Historical repository preparation pending",
                ),
              }
            : row,
        );
      }
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });
});
