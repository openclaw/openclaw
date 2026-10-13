import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../infra/update-run-timeouts.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { getStateSchemaVersionAdmission } from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { reconcileOpenClawStateSchemaPublicationAsync } from "./openclaw-state-schema-publication.async.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

async function createDeferredState() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-publication-worker-") } };
  const { db } = openOpenClawStateDatabase(options);
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  // Model completed content migration while the running legacy updater retains its version floor.
  db.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run("state.schema.contentVersion", String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
  db.exec(`PRAGMA user_version = 15;
    UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
  await closeOpenClawStateDatabaseAsync();
  return { options, run, database: openOpenClawStateDatabase(options) };
}

describe("shared state schema publication worker", () => {
  it("publishes through the worker after an in-process updater write and refreshes retained facts", async () => {
    const { options, run, database } = await createDeferredState();
    const { db } = database;
    expect(getStateSchemaVersionAdmission(db)).toEqual({
      userVersion: 15,
      contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      expect(await reconcileOpenClawStateSchemaPublicationAsync(options)).toEqual({
        runId: run.runId,
        updaterVersion: "2026.9.2",
        publishAfterMs: run.updatedAtMs + ABANDONED_UPDATE_RUN_MS + 1,
      });
      sql.expectIdle();

      // Use persisted times, not fake worker clocks or a real grace-period wait.
      const finishedAtMs = Date.now() - 10 * 60_000;
      db.prepare(
        "UPDATE update_runs SET status = 'succeeded', phase = 'finished', finished_at_ms = ?, updated_at_ms = ? WHERE run_id = ?",
      ).run(finishedAtMs, finishedAtMs, run.runId);

      sql.clear();
      expect(
        await withExistingOpenClawStateSchema({ path: database.path }, () =>
          reconcileOpenClawStateSchemaPublicationAsync(options),
        ),
      ).toBeUndefined();
      sql.expectIdle();
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      expect(getStateSchemaVersionAdmission(db)?.userVersion).toBe(15);

      sql.clear();
      expect(await reconcileOpenClawStateSchemaPublicationAsync(options)).toBeUndefined();
      sql.expectIdle();
      // Keep the original connection: reopening would hide a missing fact publication.
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      expect(getStateSchemaVersionAdmission(db)).toEqual({
        userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    } finally {
      sql.restore();
    }
  });

  it("leaves a missing state database and its parent directory uncreated", async () => {
    const stateDir = tempDirs.make("state-publication-missing-");
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      expect(
        await reconcileOpenClawStateSchemaPublicationAsync({
          path: path.join(stateDir, "missing", "state.db"),
          env: { OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toBeUndefined();
      sql.expectIdle();
      expect(readdirSync(stateDir)).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});
