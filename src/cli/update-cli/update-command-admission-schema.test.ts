import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireFileLockSync } from "../../infra/file-lock-manager.js";
import { parseGatewayLockPayload } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import {
  StateSchemaMutationConflictError,
  withStateDatabaseSchemaMaintenance,
} from "../../infra/state-database-maintenance.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
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

function previousVersionState(ledger: boolean, legacyMetadata = false) {
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
  // Exact stable table subset from fac4b318 (2026.9.2), kept unchanged while
  // a serving process prevents the candidate's runtime migrations.
  const fixture = fs.readFileSync(
    new URL("./fixtures/admission-state-fac4.sql", import.meta.url),
    "utf8",
  );
  // Schema 1 (2026.6.11) has these metadata columns, but predates STRICT tables.
  db.exec(legacyMetadata ? fixture.replace(") STRICT;", ");") : fixture);
  db.exec("PRAGMA user_version=16");
  db.prepare("INSERT INTO schema_meta VALUES ('primary','global',16,NULL,'2026.9.2',1,1)").run();
  db.prepare("INSERT INTO config_machine_state VALUES ('fixture','{\"keep\":true}',1)").run();
  if (!ledger) {
    db.exec("DROP TABLE update_runs");
  }
  const anchor = acquireGatewayStateOwner({ databasePath: filename });
  anchor.release();
  // An unregistered sidecar permits diagnostic access but cannot lend schema authority.
  const owner = acquireFileLockSync(anchor.path, {
    lockPath: anchor.path,
    retry: { retries: 0 },
    payload: () => ({
      pid: process.pid,
      ownerId: randomUUID(),
      createdAt: new Date().toISOString(),
      configPath: path.join(root, "openclaw.json"),
      role: "gateway",
    }),
    parsePayload: parseGatewayLockPayload,
  });
  const snapshot = () => ({
    meta: db.prepare("SELECT * FROM schema_meta").all(),
    version: db.prepare("PRAGMA user_version").get(),
    state: db.prepare("SELECT name FROM sqlite_schema WHERE name='config_machine_state'").get()
      ? db.prepare("SELECT * FROM config_machine_state").all()
      : null,
    schema: db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE tbl_name != 'update_runs' ORDER BY name")
      .all(),
  });
  return {
    root,
    env,
    db,
    filename,
    snapshot,
    [Symbol.dispose]() {
      owner.release();
      db.close();
    },
  };
}

it.each([
  { dryRun: true, ledger: true },
  { dryRun: false, ledger: false },
])(
  "admits dryRun=$dryRun with an older live Gateway and ledger=$ledger without migration",
  async ({ dryRun, ledger }) => {
    using f = previousVersionState(ledger);
    const before = f.snapshot();
    expect(() => openOpenClawStateDatabase({ env: f.env })).toThrow(
      StateSchemaMutationConflictError,
    );
    const run = await admitUpdateCommandRun({ opts: { dryRun }, root: f.root });
    recordUpdateRunPhase(run.runId, "validating", {}, { env: run.env });
    expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
      status: "running",
      phase: "validating",
    });
    completeUpdateCommandRun({ status: "ok", mode: "npm", durationMs: 1, steps: [] }, run);
    expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("succeeded");
    expect(f.snapshot()).toEqual(before);
    expect(() =>
      withStateDatabaseSchemaMaintenance({ databasePath: f.filename }, () => "migrated"),
    ).toThrow(StateSchemaMutationConflictError);
    expect(() => openOpenClawStateDatabase({ env: f.env })).toThrow(
      StateSchemaMutationConflictError,
    );
    expect(f.snapshot()).toEqual(before);
  },
);

it("refuses a supplied handle before ledger admission", () => {
  const root = dirs.make("update-admission-supplied-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const database = openOpenClawStateDatabase({ env });
  const before = database.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
  expect(() => createUpdateRun({ trigger: "cli" }, { env, database })).toThrow(
    "Update run admission requires its own writable connection",
  );
  expect(database.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
  expect(
    database.db.prepare("SELECT name FROM sqlite_schema WHERE name='update_runs'").get(),
  ).toBeUndefined();
  expect(database.db.isOpen).toBe(true);
});
