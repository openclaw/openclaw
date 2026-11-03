import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { getStateSchemaVersionAdmission } from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { runExistingOpenClawStateWriteTransaction } from "./openclaw-state-db-existing-write.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import {
  admitStateSchemaFacts,
  assertSupportedStateSchemaVersion,
} from "./openclaw-state-db-schema-version.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

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

it("admits a peer process publication for existing-schema writes", async () => {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("state-peer-existing-write-") } };
  const { db } = openOpenClawStateDatabase(options);
  createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  db.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run("state.schema.contentVersion", String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
  db.exec(`PRAGMA user_version = 15;
    UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
  await closeOpenClawStateDatabaseAsync();
  const opened = openOpenClawStateDatabase(options);
  expect(getStateSchemaVersionAdmission(opened.db)?.userVersion).toBe(15);
  const leaseSchema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "state_leases", {
    endMarker: ") STRICT;",
    errorMessage: "lease schema",
  });
  const write = () =>
    runExistingOpenClawStateWriteTransaction(() => true, options, {
      schemaSql: leaseSchema,
      operationLabel: "peer-publication lease write",
    });
  expect(write()).toBe(true);

  // The Gateway's watcher publishes the deferred version from another process while
  // a plugin lifecycle lease write waits for its write lock.
  const peer = spawn(
    process.execPath,
    [
      "-e",
      `const {DatabaseSync}=require("node:sqlite");
       const db=new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE; PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}; UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION} WHERE meta_key = 'primary';");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);`,
      opened.path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = once(peer, "exit");
  await once(peer.stdout, "data");
  expect(write()).toBe(true);
  expect((await exited)[0]).toBe(0);
});
