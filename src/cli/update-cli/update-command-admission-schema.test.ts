import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../../infra/sqlite-coordinator.js";
import {
  acquireGatewayLifecycleCoordinator,
  StateSchemaMutationConflictError,
  withStateSchemaFence,
} from "../../infra/state-database-coordinator.js";
import {
  createUpdateRun,
  finishInterruptedUpdateBeforeActivation,
  finishInterruptedUpdatePreview,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { runExistingOpenClawStateWriteTransaction } from "../../state/openclaw-state-db-existing-write.js";
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
  // Exact stable table subset from fac4b318 (2026.9.2). This models its
  // live SQLite lease, not a running Gateway or physical installation.
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
  const anchor = acquireGatewayLifecycleCoordinator({ databasePath: filename });
  anchor.release();
  // Independent connection avoids same-process reentrant ownership. The real
  // schema fence must contend on the same SQLite lock as a live old Gateway.
  const owner = tryAcquireExclusiveSqliteCoordinator(anchor.path);
  if (!owner) {
    throw new Error("Fixture Gateway lifecycle lease unavailable");
  }
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
  return { root, env, db, filename, owner, snapshot };
}

it.each([true, false].flatMap((dryRun) => [true, false].map((ledger) => ({ dryRun, ledger }))))(
  "admits dryRun=$dryRun with an older live Gateway and ledger=$ledger without migration",
  async ({ dryRun, ledger }) => {
    const f = previousVersionState(ledger);
    try {
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
      expect(() => withStateSchemaFence({ databasePath: f.filename }, () => "migrated")).toThrow(
        StateSchemaMutationConflictError,
      );
      expect(() => openOpenClawStateDatabase({ env: f.env })).toThrow(
        StateSchemaMutationConflictError,
      );
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.owner.release();
      f.db.close();
    }
  },
);

it("records only the exact preview interruption without opening the candidate schema", async () => {
  const f = previousVersionState(true);
  try {
    const before = f.snapshot();
    const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root: f.root });
    const expected = getUpdateRun(run.runId, { env: f.env });
    if (!expected) {
      throw new Error("Preview admission missing");
    }
    finishInterruptedUpdatePreview(expected, { env: f.env });
    expect(getUpdateRun(run.runId, { env: f.env })).toMatchObject({
      status: "skipped",
      reason: "interrupted",
    });
    expect(f.snapshot()).toEqual(before);
    expect(() => withStateSchemaFence({ databasePath: f.filename }, () => "migrated")).toThrow(
      StateSchemaMutationConflictError,
    );
  } finally {
    f.owner.release();
    f.db.close();
  }
});

it.each(["absent", "empty", "malformed", "view", "pending", "corrupt"] as const)(
  "settles schema-1 interruption only with safe recovery state: %s",
  (recovery) => {
    const f = previousVersionState(true, true);
    try {
      f.db.exec("PRAGMA user_version=1");
      f.db.exec("UPDATE schema_meta SET schema_version=1, app_version='2026.6.11'");
      f.db.exec("DELETE FROM config_machine_state");
      if (recovery === "absent") {
        f.db.exec("DROP TABLE config_machine_state");
      } else if (recovery === "view") {
        f.db.exec("DROP TABLE config_machine_state");
        f.db.exec(
          "CREATE VIEW config_machine_state AS SELECT 'fixture' AS state_key, '{}' AS value_json, 1 AS updated_at_ms",
        );
      } else if (recovery === "malformed") {
        // Still readable, but a missing canonical constraint must refuse cleanup.
        f.db.exec("DROP TABLE config_machine_state");
        f.db.exec(
          "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER NOT NULL) STRICT",
        );
      }
      const options = { env: f.env };
      const run = createUpdateRun({ trigger: "cli" }, options);
      const expected = recordUpdateRunPhase(run.runId, "validating", {}, options);
      if (recovery === "pending" || recovery === "corrupt") {
        // Another run's pending recovery also excludes this diagnostic write.
        const runId = randomUUID();
        const runtime = {
          root: f.root,
          nodePath: process.execPath,
          version: "2026.6.11",
          buildId: null,
        };
        const record = {
          runId,
          transactionId: randomUUID(),
          revision: 0,
          claimId: randomUUID(),
          claimKind: "initial",
          handoff: null,
          from: runtime,
          to: runtime,
          createdAtMs: 1,
          updatedAtMs: 1,
          effects: [],
          restore: null,
          verification: null,
          primaryFailure: null,
        };
        f.db
          .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
          .run("update.recovery." + runId, recovery === "corrupt" ? "{}" : JSON.stringify(record));
      }
      const before = f.snapshot();
      const interrupt = () => finishInterruptedUpdateBeforeActivation(expected, () => {}, options);
      if (recovery === "malformed") {
        expect(interrupt).toThrow("column definitions differ for config_machine_state");
      } else if (recovery === "view") {
        expect(interrupt).toThrow("missing table config_machine_state");
      } else if (recovery === "corrupt") {
        expect(interrupt).toThrow();
      } else {
        interrupt();
      }
      expect(getUpdateRun(run.runId, options)).toMatchObject(
        recovery === "absent" || recovery === "empty"
          ? { status: "failed", phase: "finished", reason: "interrupted" }
          : expected,
      );
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.owner.release();
      f.db.close();
    }
  },
);

it.each([
  ["newer", "PRAGMA user_version=17"],
  ["metadata", "UPDATE schema_meta SET schema_version=15"],
  ["role", "UPDATE schema_meta SET role='agent'"],
  ["drift", "ALTER TABLE update_runs RENAME COLUMN origin_json TO wrong_origin"],
  ["missing-index", "DROP INDEX idx_update_runs_active"],
])("refuses %s state instead of repairing or retrying migration", async (_, mutation) => {
  const f = previousVersionState(true);
  try {
    f.db.exec(mutation);
    const before = f.snapshot();
    const schema = f.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    await expect(admitUpdateCommandRun({ opts: { dryRun: true }, root: f.root })).rejects.toThrow();
    expect(f.db.prepare("SELECT count(*) AS n FROM update_runs").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.owner.release();
    f.db.close();
  }
});

it("rolls back first-use ledger creation with a failed write and permits a fresh admission", async () => {
  const f = previousVersionState(false);
  try {
    const schemaSql = fs.readFileSync(
      new URL("./fixtures/admission-state-fac4.sql", import.meta.url),
      "utf8",
    );
    const before = f.snapshot();
    expect(() =>
      runExistingOpenClawStateWriteTransaction(
        () => {
          throw new Error("injected admission failure");
        },
        { env: f.env },
        {
          schemaSql,
          operationLabel: "fixture.first-use",
          initializeAdditiveSchema: true,
        },
      ),
    ).toThrow("injected admission failure");
    expect(
      f.db.prepare("SELECT name FROM sqlite_schema WHERE name='update_runs'").get(),
    ).toBeUndefined();
    expect(f.snapshot()).toEqual(before);
    const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root: f.root });
    expect(getUpdateRun(run.runId, { env: f.env })?.status).toBe("running");
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.owner.release();
    f.db.close();
  }
});

it.each(["compatible", "newer", "metadata"])(
  "refuses supplied %s handles before ledger admission",
  (kind) => {
    const root = dirs.make("update-admission-supplied-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const database = openOpenClawStateDatabase({ env });
    if (kind === "newer") {
      database.db.exec("PRAGMA user_version=17");
    } else if (kind === "metadata") {
      database.db.exec("UPDATE schema_meta SET schema_version=15");
    }
    const before = database.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    expect(() => createUpdateRun({ trigger: "cli" }, { env, database })).toThrow(
      "Update run admission requires its own writable connection",
    );
    expect(database.db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    expect(
      database.db.prepare("SELECT name FROM sqlite_schema WHERE name='update_runs'").get(),
    ).toBeUndefined();
    expect(database.db.isOpen).toBe(true);
  },
);
