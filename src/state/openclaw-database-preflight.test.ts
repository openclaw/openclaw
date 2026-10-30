import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { SqliteReadOnlyInspectionContentionError } from "../infra/sqlite-readonly-worker-protocol.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { SQLITE_STAGING_TOKEN_FILES } from "../infra/sqlite-staging-token.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  compatible,
  databaseFixture,
  supportedVersions,
  versionRow,
  failureRow,
  closeDatabases,
  execSql,
  openRawDatabase,
  rejectSnapshot,
} from "./database-preflight-fixtures.test-support.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawStateDatabasePath,
} from "./openclaw-database-preflight.js";
import {
  snapshotPreflightSourceManifest,
  snapshotSourceFamily,
} from "./openclaw-database-preflight.test-support.js";
import {
  CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
} from "./openclaw-state-db-additive-columns.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { createDanglingSkillWorkshopReviewIndex } from "./openclaw-state-db-corruption.test-support.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  ensureAdditiveStateColumns,
  ensureDevicePairSetupBootstrapSchema,
} from "./openclaw-state-db-schema-additive.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import { TEMPLATE_STATE_TABLE_RENAMES } from "./openclaw-state-db-schema-v36-template-names.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  assertOpenClawStateDatabaseForMaintenance,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  withStateMigrationBackupForTest,
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabases();
});

function createState() {
  const fixture = databaseFixture(tempDirs.make("openclaw-preflight-"));
  fixture.state();
  fixture.close();
  return fixture;
}

it("keeps restart discovery off the caller thread and observes changed retained-deletion facts", async () => {
  const { statePath, ready, agent: openAgent } = createState();
  const agent = openAgent("retained");
  closeDatabases();
  execSql(agent.path, `PRAGMA user_version = ${supportedVersions.agent + 1};`);
  {
    using database = openRawDatabase(statePath);
    database
      .prepare(`INSERT INTO agent_deletion_journal
        (agent_id, agent_dir, workspace_dir, sessions_dir, database_paths_json,
          created_at, cleanup_completed, delete_files)
        VALUES ('retained', ?, '', '', ?, 1, 1, 0)`)
      .run(path.dirname(agent.path), JSON.stringify([agent.path]));
  }
  revokeSqliteDatabaseAdmissionsForPath(statePath);
  for (const retained of [true, false]) {
    if (!retained) {
      execSql(statePath, "DELETE FROM agent_deletion_journal WHERE agent_id = 'retained';");
      revokeSqliteDatabaseAdmissionsForPath(statePath);
    }
    const callerSql: string[] = [];
    const observer = observeHostDataSql((sql, database) => {
      // Snapshot staging locks retain their native owner; payload inspection must move.
      if (database && path.basename(database.location() ?? "") !== SQLITE_STAGING_TOKEN_FILES[0]) {
        callerSql.push(sql);
      }
    });
    try {
      const readiness = ready(undefined, "gateway-restart");
      if (retained) {
        await expect(readiness).resolves.toBeUndefined();
      } else {
        await expect(readiness).rejects.toMatchObject({
          incompatibleDatabases: [
            {
              ...versionRow("agent", agent.path, supportedVersions.agent + 1),
              agentId: "retained",
            },
          ],
        });
      }
      expect(callerSql).toEqual([]);
    } finally {
      observer.restore();
    }
  }
});

function createReleasedStateDatabase() {
  const fixture = databaseFixture(tempDirs.make("openclaw-startup-database-admission-"));
  const { dir: stateDir, statePath } = fixture;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const archive = new URL(
    "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
    import.meta.url,
  );
  fs.writeFileSync(statePath, gunzipSync(fs.readFileSync(archive)));
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  return fixture;
}

it("refuses released legacy audit state before changing any persistent artifact", async () => {
  const { dir: stateDir, statePath, ready } = createReleasedStateDatabase();
  const before = snapshotPreflightSourceManifest(stateDir);
  await expect(ready()).rejects.toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
  expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
  await expect(preflightOpenClawStateDatabasePath(statePath)).resolves.toMatchObject({
    foundVersion: 1,
  });
});

it("refuses a configured legacy agent database without mutating its WAL or creating stores", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-agent-startup-admission-"));
  const { dir: stateDir } = fixture;
  const agentPath = path.join(stateDir, "custom", "openclaw-agent.sqlite");
  fixture.agent("main", agentPath);
  closeDatabases();
  using writer = openRawDatabase(agentPath);
  writer.exec(
    "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA user_version = 15; UPDATE schema_meta SET schema_version = 15;",
  );
  const config = { session: { store: path.join(stateDir, "custom", "sessions.json") } };
  const before = snapshotPreflightSourceManifest(stateDir, agentPath);
  await expect(fixture.ready(config)).rejects.toBeInstanceOf(
    OpenClawAgentDatabaseMediaMigrationRequiredError,
  );
  expect(snapshotPreflightSourceManifest(stateDir, agentPath)).toEqual(before);
});

it("rejects a canonical configured agent path owned by another agent before writes", async () => {
  const root = tempDirs.make("openclaw-configured-agent-owner-");
  const fixture = databaseFixture(path.join(root, "active"));
  const agentDir = path.join(root, "external", "agents", "alpha");
  const agentPath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
  const store = path.join(agentDir, "sessions", "sessions.json");
  fixture.state();
  databaseFixture(path.join(root, "donor")).agent("beta", agentPath);
  closeDatabases();
  const before = snapshotPreflightSourceManifest(root);
  await expect(fixture.ready({ session: { store } })).rejects.toThrow(
    "belongs to agent beta; requested agent alpha",
  );
  expect(snapshotPreflightSourceManifest(root)).toEqual(before);
});

it("admits supported forward state migration with backup custody after the Doctor-owned audit repair", async () => {
  const fixture = createReleasedStateDatabase();
  const { dir: stateDir, statePath } = fixture;
  {
    using database = openRawDatabase(statePath);
    expect(repairAuditEventsSchema(database)).toBe(true);
  }
  const before = snapshotPreflightSourceManifest(stateDir);
  await expect(fixture.ready()).resolves.toBeUndefined();
  expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
  await withStateMigrationBackupForTest({ env: fixture.env }, () => fixture.state());
  const migrated = fixture.state();
  expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: supportedVersions.state,
  });
});

it.each([false, true])(
  "recognizes deferred content and still checks its shape (damaged: %s)",
  async (damaged) => {
    const fixture = databaseFixture(tempDirs.make("openclaw-preflight-deferred-schema-"));
    const { env } = fixture;
    const statePath = fixture.state().path;
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
    closeOpenClawStateDatabaseForTest();
    {
      using database = openRawDatabase(statePath);
      database.exec(
        `PRAGMA user_version = ${supportedVersions.state - 1}; UPDATE schema_meta SET schema_version = ${supportedVersions.state - 1};`,
      );
      database
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("state.schema.contentVersion", String(supportedVersions.state), Date.now());
      if (damaged) {
        database.exec(
          "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
        );
      }
    }
    const before = snapshotSourceFamily(statePath);
    const result = await fixture.inspect({ verifyCurrentSchemaShape: true });
    const indeterminate = damaged
      ? [
          expect.objectContaining({
            kind: "state",
            reason: expect.stringContaining("column definitions differ for worktrees"),
          }),
        ]
      : [];
    expect(result.pendingMigrations).toBeUndefined();
    expect(result.incompatible).toEqual([]);
    expect(result.deferredSchemaPublications).toEqual([
      expect.objectContaining({
        kind: "state",
        path: statePath,
        foundVersion: supportedVersions.state - 1,
        contentVersion: supportedVersions.state,
        runId: run.runId,
      }),
    ]);
    expect(result.indeterminate).toEqual(indeterminate);
    const olderTarget = await fixture.inspect(
      {
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: supportedVersions.state - 2,
          agent: supportedVersions.agent,
        },
      },
      "runtime",
    );
    expect(olderTarget.incompatible).toEqual([
      expect.objectContaining({ foundVersion: supportedVersions.state - 1 }),
    ]);
    expect(olderTarget.indeterminate).toEqual(indeterminate);
    expect(snapshotSourceFamily(statePath)).toEqual(before);
    if (damaged) {
      await expect(fixture.ready(undefined, "gateway-restart")).rejects.toThrow(
        /Gateway refused restart.*column definitions differ for worktrees/su,
      );
    } else {
      await expect(
        fixture.inspect({
          supportedVersions: {
            state: supportedVersions.state - 1,
            agent: supportedVersions.agent,
          },
        }),
      ).resolves.toMatchObject({
        incompatible: [expect.objectContaining({ foundVersion: supportedVersions.state })],
      });
      await expect(preflightOpenClawStateDatabasePath(statePath)).resolves.toMatchObject({
        status: "exact",
        foundVersion: supportedVersions.state - 1,
        contentVersion: supportedVersions.state,
        deferredPublication: expect.objectContaining({ runId: run.runId }),
      });
    }
  },
);

it("holds an unregistered store without deletion history or creating shared state", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-unregistered-readiness-"));
  const { env, statePath } = fixture;
  const agent = fixture.agent();
  closeDatabases();
  fs.unlinkSync(statePath);
  execSql(
    agent.path,
    "PRAGMA journal_mode = DELETE; DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
  );
  const options = {
    env,
    operation: "doctor" as const,
    configuredAgentDatabaseTargets: [],
  };
  const before = snapshotSourceFamily(agent.path);
  await expect(assertOpenClawDatabasesReady(options)).resolves.toBeUndefined();
  const onAgentDatabaseDiscovery = vi.fn();
  await expect(fixture.inspect({ ...options, onAgentDatabaseDiscovery })).resolves.toEqual(
    compatible,
  );
  expect(onAgentDatabaseDiscovery).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      discovery: expect.objectContaining({
        targets: [],
        deletionJournal: expect.objectContaining({ status: "unavailable", cause: "missing" }),
        retainedTargets: [],
        unverifiedTargets: [
          {
            agentId: "main",
            path: agent.path,
            realPath: fs.realpathSync.native(agent.path),
            source: "disk",
          },
        ],
      }),
    }),
  );
  expect(snapshotSourceFamily(agent.path)).toEqual(before);
  expect(fs.existsSync(statePath)).toBe(false);
});

it("checks every registered owner before permitting Gateway restart", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-preflight-conflicting-owners-"));
  const agentPath = fixture.agent().path;
  const { statePath } = fixture;
  closeDatabases();
  {
    using registry = openRawDatabase(statePath);
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ops", agentPath, supportedVersions.agent, 1, null);
  }

  await expect(fixture.ready(undefined, "gateway-restart")).rejects.toThrow(
    /Gateway refused restart.*belongs to agent main; requested agent ops/s,
  );
});
it("reports a failed agent registry query as indeterminate", async () => {
  const { statePath, inspect } = createState();
  execSql(statePath, "DROP TABLE agent_databases; CREATE TABLE agent_databases (bad TEXT) STRICT;");
  expect(await inspect()).toEqual({
    incompatible: [],
    indeterminate: [
      failureRow(
        "state",
        statePath,
        expect.stringContaining("agent database registry query failed"),
      ),
    ],
  });
});

it.runIf(process.platform !== "win32")(
  "keeps partial configured-store inventory when one candidate lookup is denied",
  async () => {
    const { inspect } = createState();
    const visibleDir = tempDirs.make("openclaw-configured-visible-");
    const deniedDir = tempDirs.make("openclaw-configured-denied-");
    const visiblePath = path.join(visibleDir, "newer.sqlite");
    const deniedPath = path.join(deniedDir, "owned.sqlite");
    const absentPath = path.join(visibleDir, "absent.sqlite");
    for (const databasePath of [visiblePath, deniedPath]) {
      execSql(
        databasePath,
        `PRAGMA user_version = ${supportedVersions.agent + (databasePath === visiblePath ? 1 : 0)};`,
      );
    }

    fs.chmodSync(deniedDir, 0o000);
    let result: Awaited<ReturnType<typeof inspect>>;
    try {
      result = await inspect({
        configuredAgentDatabaseCandidatePaths: [visiblePath, deniedPath, absentPath],
      });
    } finally {
      fs.chmodSync(deniedDir, 0o700);
    }

    expect(result).toEqual({
      incompatible: [
        versionRow("agent", visiblePath, supportedVersions.agent + 1, supportedVersions.agent),
      ],
      indeterminate: [
        failureRow("agent", deniedPath, expect.stringMatching(/EACCES|permission denied/iu)),
      ],
    });
  },
);

it("admits a dangling Workshop index only for Doctor without mutating the source", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-preflight-dangling-workshop-"));
  const statePath = fixture.state().path;
  closeOpenClawStateDatabaseForTest();
  createDanglingSkillWorkshopReviewIndex(statePath);
  const sourceDir = path.dirname(statePath);
  const snapshot = () =>
    fs
      .readdirSync(sourceDir)
      .toSorted()
      .map((name) => [name, fs.readFileSync(path.join(sourceDir, name))]);
  const before = snapshot();

  const runtime = await fixture.inspect({ scope: "state" });
  expect(runtime.indeterminate).toEqual([
    expect.objectContaining({ reason: expect.stringMatching(/openclaw doctor --fix/) }),
  ]);
  expect(snapshot()).toEqual(before);

  await expect(
    fixture.inspect({
      scope: "state",
      openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
      supportedVersions,
    }),
  ).resolves.toEqual(compatible);
  expect(snapshot()).toEqual(before);
});

it.each([
  {
    name: "retryable snapshot contention",
    error: new SqliteReadOnlyInspectionContentionError("snapshot did not stabilize"),
    guidance: "Wait a moment for write activity to settle, then retry the inspection.",
    restore: false,
  },
  {
    name: "database corruption",
    error: new Error("database disk image is malformed"),
    guidance: "Stop OpenClaw processes, then restore the affected database from a verified backup.",
    restore: true,
  },
])(
  "keeps Doctor's refusal and gives the next step for $name",
  async ({ error, guidance, restore }) => {
    const fixture = databaseFixture(tempDirs.make("doctor-readiness-guidance-"));
    fixture.state();
    closeDatabases();
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockRejectedValueOnce(error);

    const failure = await fixture.doctor().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    for (const message of ["Doctor could not complete repair", error.message, guidance]) {
      expect(failure).toMatchObject({ message: expect.stringContaining(message) });
    }
    if (!restore) {
      expect(failure).toMatchObject({ message: expect.not.stringContaining("restore") });
    }
  },
);

it("keeps retry and restore guidance with their affected agent databases", async () => {
  const fixture = databaseFixture(tempDirs.make("doctor-mixed-readiness-"));
  const busy = fixture.agent("busy");
  const corrupt = fixture.agent("corrupt");
  closeDatabases();
  const prepare = snapshots.prepareSqliteReadOnlyLocation;
  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation((source, options) => {
    if (source === busy.path) {
      throw new SqliteReadOnlyInspectionContentionError("snapshot did not stabilize");
    }
    if (source === corrupt.path) {
      throw new Error("database disk image is malformed");
    }
    return prepare(source, options);
  });

  await expect(
    withArtifactPreservingStateReads(() => fixture.doctor(), { agentDatabases: true }),
  ).rejects.toThrow(
    `Doctor could not complete repair because persisted database readiness could not be verified:\nagent ${busy.path}: snapshot did not stabilize Wait a moment for write activity to settle, then retry the inspection.\nagent ${corrupt.path}: database disk image is malformed Stop OpenClaw processes, then restore the affected database from a verified backup.`,
  );
});

it("upgrades captured subagent authority state without rewriting rows and refuses schema-24 targets", async () => {
  const fixture = databaseFixture(tempDirs.make("subagent-authority-format-"));
  const pathname = fixture.state().path;
  await closeOpenClawStateDatabaseAsync();
  const payload = JSON.stringify({
    runId: "interrupted-child",
    operatorRecoverySource: {
      version: 1,
      snapshot: { profileId: "original-operator", scopes: ["operator.write"] },
    },
  });
  const catalogSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
  let catalog;
  {
    using writer = openRawDatabase(pathname);
    // Raw catalog equality needs a post-cutover reference, not fresh CREATE
    // spelling: SQLite quotes table names after the legitimate rename cycle.
    for (const table of [
      ...TEMPLATE_STATE_TABLE_RENAMES.map(([, current]) => current),
      "agent_provenance",
    ]) {
      if (writer.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table)) {
        writer.exec(`ALTER TABLE ${table} RENAME TO ${table}_fixture_cutover;
          ALTER TABLE ${table}_fixture_cutover RENAME TO ${table};`);
      }
    }
    catalog = writer.prepare(catalogSql).all();
    restorePreTemplateStateIdentifiersForTest(writer);
    addPreCutoverClientCredentialTablesForTest(writer);
    writer.exec(`PRAGMA user_version = 24;
      UPDATE schema_meta SET schema_version = 24 WHERE meta_key = 'primary';
      UPDATE config_machine_state SET value_json = '24'
        WHERE state_key = 'state.schema.contentVersion';`);
    writer
      .prepare(`INSERT INTO subagent_runs
      (run_id, child_session_key, requester_session_key, created_at, payload_json)
      VALUES ('interrupted-child', 'agent:main:subagent:child', 'agent:main:main', 1, ?)`)
      .run(payload);
  }
  // A prior process's file must acquire fresh physical admission, not cached version facts.
  fs.renameSync(pathname, `${pathname}.v24`);
  fs.copyFileSync(`${pathname}.v24`, pathname);
  await withStateMigrationBackupForTest({ env: fixture.env }, () => fixture.state());
  const { db } = fixture.state();
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: supportedVersions.state,
  });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: supportedVersions.state });
  expect(
    db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = 'interrupted-child'").get(),
  ).toEqual({ payload_json: payload });
  expect(db.prepare(catalogSql).all()).toEqual(catalog);
  await closeOpenClawStateDatabaseAsync();
  expect(
    await fixture.inspect({
      scope: "state",
      supportedVersions: { state: 24, agent: supportedVersions.agent },
    }),
  ).toMatchObject({
    incompatible: [versionRow("state", pathname, supportedVersions.state, 24)],
    indeterminate: [],
  });
});

it("keeps readiness on the admitted shared-state snapshot and observes changes in the next admission", async () => {
  const fixture = databaseFixture(tempDirs.make("schema-admitted-snapshot-"));
  const state = fixture.state();
  const inspect = () => fixture.inspect({ scope: "state", requireStartupMigrationReadiness: true });
  try {
    await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          state.db.exec(`PRAGMA user_version = ${supportedVersions.state + 1};`);
          expect(await inspect()).toEqual(compatible);
        },
        { env: fixture.env },
      ),
    );
    expect(await inspect()).toMatchObject({
      incompatible: [versionRow("state", state.path, supportedVersions.state + 1)],
      indeterminate: [],
    });
  } finally {
    state.db.exec(`PRAGMA user_version = ${supportedVersions.state};`);
  }
});

it.each(["DELETE", "WAL"])(
  "checks committed shared-state metadata without snapshot space (%s)",
  async (journalMode) => {
    const fixture = databaseFixture(tempDirs.make("state-schema-only-"));
    const pathname = fixture.state().path;
    closeOpenClawStateDatabaseForTest();
    using writer = openRawDatabase(pathname);
    writer.exec(`PRAGMA journal_mode=${journalMode}; PRAGMA wal_autocheckpoint=0;`);
    rejectSnapshot(pathname, "No space for a shared-state snapshot", true);
    const inspect = () =>
      fixture.inspect({
        scope: "state",
        preserveSourceArtifacts: false,
        verifyCurrentSchemaShape: true,
      });
    expect(await inspect()).toEqual(compatible);
    writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=999;");
    try {
      expect(await inspect()).toEqual(compatible);
      expect(writer.isTransaction).toBe(true);
      expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
    } finally {
      writer.exec("ROLLBACK;");
    }
    writer.exec(`PRAGMA user_version=${supportedVersions.state + 1};`);
    expect(await inspect()).toMatchObject({
      incompatible: [versionRow("state", pathname, supportedVersions.state + 1)],
      indeterminate: [],
    });
    writer.exec(`PRAGMA user_version=${supportedVersions.state}; DROP TABLE schema_meta;`);
    expect(await inspect()).toMatchObject({
      incompatible: [],
      indeterminate: [{ kind: "state", path: pathname }],
    });
  },
);

it("checks fresh metadata without space for an agent snapshot", async () => {
  const fixture = databaseFixture(tempDirs.make("schema-only-preflight-"));
  const agentPath = fixture.agent("worker").path;
  closeDatabases();
  using writer = openRawDatabase(agentPath);
  writer.exec("PRAGMA journal_mode=DELETE; PRAGMA wal_autocheckpoint=0;");
  writer
    .prepare("UPDATE schema_meta SET app_version='inspection-fixture' WHERE meta_key='primary'")
    .run();
  rejectSnapshot(agentPath, "No space for a full agent database snapshot", true);
  const config = { agents: { entries: { worker: {} } } };
  const ready = (operation: "doctor" | "gateway-restart" | "gateway-startup") =>
    operation === "doctor"
      ? fixture.doctor([{ agentId: "worker", path: agentPath }], config)
      : fixture.ready(config, operation);
  const inspect = (verifyCurrentSchemaShape: boolean) =>
    fixture.inspect({ verifyCurrentSchemaShape, agentAdmissionConfig: config, supportedVersions });
  await expect(ready("doctor")).resolves.toBeUndefined();
  await expect(ready("gateway-restart")).resolves.toBeUndefined();
  await expect(ready("gateway-startup")).resolves.toBeUndefined();
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(await inspect(verifyCurrentSchemaShape), `shape=${verifyCurrentSchemaShape}`).toEqual(
      compatible,
    );
  }
  writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=999;");
  try {
    await expect(ready("doctor")).resolves.toBeUndefined();
    expect(writer.isTransaction).toBe(true);
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
  } finally {
    writer.exec("ROLLBACK;");
  }
  writer.exec(`PRAGMA user_version=${supportedVersions.agent + 1};`);
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      await inspect(verifyCurrentSchemaShape),
      `shape=${verifyCurrentSchemaShape}`,
    ).toMatchObject({
      incompatible: [
        {
          ...versionRow("agent", agentPath, supportedVersions.agent + 1),
          writerAppVersion: "inspection-fixture",
        },
      ],
      indeterminate: [],
    });
  }
  writer.exec(`PRAGMA user_version=${supportedVersions.agent};`);
  writer.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run("foreign");
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      (await inspect(verifyCurrentSchemaShape)).agentRefusals,
      `shape=${verifyCurrentSchemaShape}`,
    ).toEqual([
      expect.objectContaining({ agentId: "worker", code: "agent-database-ownership-mismatch" }),
    ]);
  }
  await expect(ready("doctor")).rejects.toThrow("belongs to agent foreign");
  await expect(ready("gateway-restart")).rejects.toThrow("belongs to agent foreign");
  await expect(ready("gateway-startup")).rejects.toThrow("belongs to agent foreign");
  writer.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run("worker");
  writer.exec("DROP INDEX idx_agent_cache_expiry;");
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      await inspect(verifyCurrentSchemaShape),
      `shape=${verifyCurrentSchemaShape}`,
    ).toMatchObject({
      incompatible: [],
      indeterminate: verifyCurrentSchemaShape
        ? [failureRow("agent", agentPath, expect.stringContaining("idx_agent_cache_expiry"))]
        : [],
    });
  }
  writer.exec("ALTER TABLE schema_meta RENAME COLUMN agent_id TO retired_agent_id;");
  expect(await inspect(false), "shape=false").toMatchObject({
    incompatible: [],
    indeterminate: [expect.objectContaining({ kind: "agent", path: agentPath })],
  });
});

it.each([
  { mode: "header", cleanupFailure: "false" },
  { mode: "startup", cleanupFailure: "reject" },
] as const)(
  "finishes sibling inspections after private snapshot cleanup $cleanupFailure ($mode)",
  async ({ mode, cleanupFailure }) => {
    const fixture = databaseFixture(tempDirs.make("schema-owned-snapshot-"));
    const agentPath = fixture.agent("worker").path;
    for (const agentId of ["sibling", "queued"]) {
      fixture.agent(agentId);
    }
    closeDatabases();
    const snapshotPath = path.join(tempDirs.make("schema-owned-copy-"), "snapshot.sqlite");
    fs.copyFileSync(agentPath, snapshotPath);
    const cleanup = vi.fn(() => true);
    const controller = new AbortController();
    const onAgentInspection = vi.fn();
    const rejectedCleanup = new Error("snapshot cleanup failed: fixture removal rejected");
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        if (path.resolve(pathname) !== agentPath) {
          return prepare(pathname, options);
        }
        return { location: snapshotPath, cleanup, cleanupAsync: async () => cleanup() };
      },
    );
    const inspect = () => {
      const run = () =>
        fixture.inspect({
          preserveSourceArtifacts: true,
          verifyCurrentSchemaShape: mode !== "header",
          requireStartupMigrationReadiness: mode === "startup",
          signal: controller.signal,
          onAgentInspection,
          supportedVersions,
        });
      return mode === "startup" ? withAgentDatabaseStartupAdmission(run) : run();
    };
    expect(await inspect()).toEqual(compatible);
    if (cleanupFailure === "false") {
      cleanup.mockReturnValue(false);
    } else {
      cleanup.mockImplementation(() => {
        throw rejectedCleanup;
      });
    }
    onAgentInspection.mockClear();
    expect(await inspect()).toEqual({
      ...compatible,
      ...(mode === "startup"
        ? {
            agentRefusals: [
              expect.objectContaining({
                agentId: "worker",
                paths: [agentPath],
                code: "agent-database-inspection-failed",
                reason: expect.stringContaining("snapshot cleanup failed"),
              }),
            ],
          }
        : {
            indeterminate: [
              failureRow("agent", agentPath, expect.stringContaining("snapshot cleanup failed")),
            ],
          }),
    });
    expect(onAgentInspection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ schemaInspectionCount: 3 }),
    );
    if (cleanupFailure === "reject") {
      const cancelled = new Error("caller stopped during cleanup");
      cleanup.mockImplementation(() => {
        controller.abort(cancelled);
        throw rejectedCleanup;
      });
      await expect(inspect()).rejects.toBe(cancelled);
    }
    expect(cleanup).toHaveBeenCalledTimes(cleanupFailure === "reject" ? 3 : 2);
  },
);

it("keeps every same-version additive column bare and canonical", () => {
  using database = createDatabase();
  const authorizationIndex = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_user_profile_identities_authorization'",
    )
    .get()?.sql;
  if (typeof authorizationIndex !== "string") {
    throw new Error("Canonical channel authorization index is missing");
  }
  // A schema predating the authorization columns also predates their index.
  database.exec("DROP INDEX idx_user_profile_identities_authorization;");
  for (const { columnName, dataType, tableName } of CLAW_LAZY_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
    expectBareColumn(database, tableName, columnName, dataType);
    database.exec(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}";`);
  }

  ensureAdditiveStateColumns(database, "runtime");
  database.exec(authorizationIndex);
  expect(() =>
    assertOpenClawStateDatabaseForMaintenance(database, {
      pathname: "global.sqlite",
    }),
  ).not.toThrow();
  for (const column of CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
    expectBareColumn(database, column.tableName, column.columnName, column.dataType);
  }
  expect(readColumn(database, "device_bootstrap_tokens", "setup_id")).toBeUndefined();

  ensureDevicePairSetupBootstrapSchema(database);
  expectBareColumn(database, "device_bootstrap_tokens", "setup_id", "TEXT");
});

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(OPENCLAW_STATE_SCHEMA_SQL);
  database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
  database
    .prepare(`INSERT INTO schema_meta
      (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
      VALUES ('primary', ?, ?, ?, NULL, 1, 1)`)
    .run("global", OPENCLAW_STATE_SCHEMA_VERSION, null);
  return database;
}

function expectBareColumn(database: DatabaseSync, table: string, name: string, type: string) {
  const expected = { dflt_value: null, hidden: 0, name, notnull: 0, pk: 0, type };
  expect(readColumn(database, table, name)).toEqual(expected);
}

function readColumn(db: DatabaseSync, table: string, name: string) {
  return db
    .prepare(
      'SELECT dflt_value, hidden, name, "notnull", pk, type FROM pragma_table_xinfo(?) WHERE name = ?',
    )
    .get(table, name);
}
