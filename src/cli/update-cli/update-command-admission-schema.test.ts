import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../../infra/state-database-maintenance.js";
import * as ledger from "../../infra/update-run-ledger.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUnregisteredStateOwner } from "./unregistered-state-owner.test-support.js";
import { admitUpdateCommandRun, completeUpdateCommandRun } from "./update-command-run.js";

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));
vi.mock("../../infra/update-run-driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-driver.js")>()),
  readUpdateRunDriver: () => ({ host: "admission-fixture", pid: 1234, startIdentity: "5678" }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function previousVersionState(hasLedger: boolean) {
  const root = dirs.make("update-admission-schema-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  vi.stubEnv("OPENCLAW_POST_CORE_UPDATE", undefined);
  const env = { ...process.env };
  const filename = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  // Stable fac4b318 (2026.9.2) tables; the serving owner must prevent runtime migrations.
  db.exec(fs.readFileSync(new URL("./fixtures/admission-state-fac4.sql", import.meta.url), "utf8"));
  db.exec("PRAGMA user_version=16");
  db.prepare("INSERT INTO schema_meta VALUES ('primary','global',16,NULL,'2026.9.2',1,1)").run();
  db.prepare("INSERT INTO config_machine_state VALUES ('fixture','{\"keep\":true}',1)").run();
  if (!hasLedger) {
    db.exec("DROP TABLE update_runs");
  }
  const owner = createUnregisteredStateOwner(filename, "gateway");
  const snapshot = () =>
    [
      "SELECT * FROM schema_meta",
      "PRAGMA user_version",
      "SELECT * FROM config_machine_state",
      "SELECT name,sql FROM sqlite_schema WHERE tbl_name != 'update_runs' ORDER BY name",
    ].map((sql) => db.prepare(sql).all());
  return {
    root,
    env,
    filename,
    snapshot,
    [Symbol.dispose]() {
      owner.release();
      db.close();
    },
  };
}

it.each([true, false])("admits old state (dryRun/existing ledger: %s)", async (dryRun) => {
  using f = previousVersionState(dryRun);
  const before = f.snapshot();
  const assertMigrationBlocked = () => {
    expect(() => openOpenClawStateDatabase({ env: f.env })).toThrow(
      StateSchemaMutationConflictError,
    );
    expect(f.snapshot()).toEqual(before);
  };
  assertMigrationBlocked();
  const run = await admitUpdateCommandRun({ opts: { dryRun }, root: f.root, env: f.env });
  ledger.recordUpdateRunPhase(run.runId, "validating", {}, { env: run.env });
  expect(ledger.getUpdateRun(run.runId, { env: run.env })).toMatchObject({
    status: "running",
    phase: "validating",
  });
  completeUpdateCommandRun({ status: "ok", mode: "npm", durationMs: 1, steps: [] }, run);
  expect(ledger.getUpdateRun(run.runId, { env: run.env })?.status).toBe("succeeded");
  expect(f.snapshot()).toEqual(before);
  expect(() =>
    withStateDatabaseSchemaMaintenance({ databasePath: f.filename }, () => "migrated"),
  ).toThrow(StateSchemaMutationConflictError);
  assertMigrationBlocked();
});

it("refuses a supplied handle before ledger admission", () => {
  const root = dirs.make("update-admission-supplied-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const database = openOpenClawStateDatabase({ env });
  const before = database.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  expect(() => ledger.createUpdateRun({ trigger: "cli" }, { env, database })).toThrow(
    "Update run admission requires its own writable connection",
  );
  expect(database.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
  expect(
    database.db.prepare("SELECT name FROM sqlite_schema WHERE name='update_runs'").get(),
  ).toBeUndefined();
  expect(database.db.isOpen).toBe(true);
});
