import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import * as handles from "../state/openclaw-state-db-handle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import { createUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";
import { updateRunLedgerSchema } from "./update-run-write.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function source() {
  const root = dirs.make("openclaw-handoff-before-migration-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = {
    root: path.join(root, "previous"),
    nodePath: process.execPath,
    version: "1.0.0",
    buildId: "old",
  };
  const to = { ...from, root: path.join(root, "candidate"), version: "2.0.0", buildId: "new" };
  const record = createRetainedUpdateRecovery({ runId: run.runId, from, to }, options);
  record.handoff = { handoffId: randomUUID(), state: "prepared" };
  storeRetainedUpdateRecovery(record, options);
  const pathname = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  using legacy = openNodeSqliteDatabase(pathname);
  // Older markers on current layout, not a v15 migration fixture.
  legacy.exec(`PRAGMA foreign_keys=OFF;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  return { options, run, record, pathname };
}
function shape(pathname: string) {
  using db = openNodeSqliteDatabase(pathname, { readOnly: true });
  return {
    version: db.prepare("PRAGMA user_version").get(),
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    recovery: db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key LIKE 'update.recovery.%'",
      )
      .get(),
  };
}
it("refuses existing-state writes while another connection holds the native transaction", () => {
  const f = source();
  const before = fs.readFileSync(f.pathname);
  using writer = openNodeSqliteDatabase(f.pathname);
  writer.exec("BEGIN IMMEDIATE");
  expect(() => probeExistingWriter(f, 0)).toThrow(/locked/);
  expect(fs.readFileSync(f.pathname)).toEqual(before);
  writer.exec("ROLLBACK");
});

it.each([
  [
    "future",
    "PRAGMA user_version=2147483647; UPDATE schema_meta SET schema_version=2147483647 WHERE meta_key='primary'",
  ],
  ["metadata", "UPDATE schema_meta SET schema_version=14 WHERE meta_key='primary'"],
  [
    "trigger",
    "CREATE TRIGGER unexpected_recovery_write AFTER UPDATE ON update_runs BEGIN UPDATE schema_meta SET app_version='unexpected'; END;",
  ],
])("refuses %s state without changing a retained handoff", (_scenario, sql) => {
  const f = source();
  {
    using db = openNodeSqliteDatabase(f.pathname);
    db.exec(sql);
  }
  const before = shape(f.pathname);
  expect(() => probeExistingWriter(f)).toThrow();
  expect(shape(f.pathname)).toEqual(before);
  expect(before.recovery).toBeDefined();
  expect(JSON.parse(String(before.recovery?.value_json))).toEqual(f.record);
});

it.each(["before admission", "before tracked open"])(
  "does not recreate state displaced %s",
  (when) => {
    const f = source();
    const before = shape(f.pathname);
    const open = handles.openTrackedStateDatabase;
    if (when === "before admission") {
      fs.renameSync(f.pathname, f.pathname + ".retained");
    }
    using _ =
      when === "before tracked open"
        ? vi.spyOn(handles, "openTrackedStateDatabase").mockImplementation((pathname, options) => {
            fs.renameSync(pathname, pathname + ".retained");
            return open(pathname, options);
          })
        : undefined;
    expect(() => probeExistingWriter(f)).toThrow();
    expect(fs.existsSync(f.pathname)).toBe(false);
    expect(shape(f.pathname + ".retained")).toEqual(before);
    expect(before.version).toEqual({ user_version: 15 });
  },
);

function probeExistingWriter(f: ReturnType<typeof source>, busyTimeoutMs?: number) {
  return runExistingOpenClawStateWriteTransaction(() => undefined, f.options, {
    schemaSql: updateRunLedgerSchema,
    operationLabel: "retained-test-owner",
    busyTimeoutMs,
  });
}
it("preserves the previous runtime schema during ledger bookkeeping", () => {
  const f = source();
  const before = shape(f.pathname);
  expect(recordUpdateRunPhase(f.run.runId, "verifying", {}, f.options).phase).toBe("verifying");
  closeOpenClawStateDatabaseForTest();
  expect(shape(f.pathname)).toEqual(before);
});
