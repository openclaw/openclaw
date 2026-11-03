import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { getStateSchemaVersionAdmission } from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "./openclaw-state-db-schema-version.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("adopts a peer process publication on a retained connection", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-peer-publication-") } };
  const { db } = openOpenClawStateDatabase(options);
  const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  db.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run("state.schema.contentVersion", String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
  db.exec(`PRAGMA user_version = 15;
    UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);

  await closeOpenClawStateDatabaseAsync();
  const opened = openOpenClawStateDatabase(options);
  const retained = requireNativeSqliteDatabase(opened.db);
  expect(getStateSchemaVersionAdmission(opened.db)?.userVersion).toBe(15);
  const finishedAtMs = Date.now() - 10 * 60_000;
  opened.db
    .prepare(
      "UPDATE update_runs SET status = 'succeeded', phase = 'finished', finished_at_ms = ?, updated_at_ms = ? WHERE run_id = ?",
    )
    .run(finishedAtMs, finishedAtMs, run.runId);

  // The restarted Gateway's watcher publishes from another process once the grace expires.
  const peer = new DatabaseSync(opened.path);
  try {
    peer.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION} WHERE meta_key = 'primary';`);
  } finally {
    peer.close();
  }

  expect(() => assertCurrentStateRuntimeSchema(retained, opened.path)).not.toThrow();

  // The updater's other read connections admit the published header.
  const reader = openNodeSqliteDatabase(opened.path, { readOnly: true });
  try {
    admitStateSchemaFacts(reader, opened.path);
    expect(assertSupportedStateSchemaVersion(reader, opened.path)).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    assertCurrentStateRuntimeSchema(reader, opened.path);
  } finally {
    reader.close();
  }

  const borrowed = openOpenClawStateDatabase(options);
  const borrowedDatabase = requireNativeSqliteDatabase(borrowed.db);
  expect(borrowed).toBe(opened);
  expect(getStateSchemaVersionAdmission(borrowed.db)).toEqual({
    userVersion: OPENCLAW_STATE_SCHEMA_VERSION,
    contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(() => assertCurrentStateRuntimeSchema(borrowedDatabase, opened.path)).not.toThrow();
});
