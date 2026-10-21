import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { SQLITE_STAGING_TOKEN_FILES } from "../infra/sqlite-staging-token.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import {
  compatible,
  databaseFixture,
  supportedVersions,
  versionRow,
  failureRow,
  closeDatabases,
  execSql,
  openRawDatabase,
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
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(closeDatabases);

function createState() {
  const fixture = databaseFixture(tempDirs.make("openclaw-preflight-"));
  fixture.state();
  fixture.close();
  return fixture;
}

it("keeps package schema support metadata aligned", () => {
  expect(packageJson.openclaw.schemaVersions).toEqual(supportedVersions);
});

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
    onAgentInspection: vi.fn(),
  };
  const before = snapshotSourceFamily(agent.path);
  await expect(assertOpenClawDatabasesReady(options)).resolves.toBeUndefined();
  expect(options.onAgentInspection).toHaveBeenCalledExactlyOnceWith({
    schemaProcessCount: 0,
    schemaInspectionCount: 0,
    schemaSnapshotCount: 0,
  });
  const onAgentDatabaseDiscovery = vi.fn();
  await expect(fixture.inspect({ ...options, onAgentDatabaseDiscovery })).resolves.toEqual(
    compatible,
  );
  expect(onAgentDatabaseDiscovery).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      discovery: expect.objectContaining({
        targets: [],
        deletionJournal: {
          status: "unavailable",
          cause: "missing",
          reason: "shared state database missing",
        },
        retainedTargets: [],
        unverifiedTargets: [
          {
            agentId: "main",
            path: agent.path,
            realPath: fs.realpathSync.native(agent.path),
            source: "disk",
          },
        ],
        registryRemovals: [],
        failures: [],
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
  {
    using database = openRawDatabase(statePath);
    database.exec(
      "CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT; CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
    );
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                         ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
          WHERE type = 'index'
            AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
      )
      .run();
    // SAFETY: PRAGMA schema_version always returns one numeric row for an open database.
    const { schema_version } = database.prepare("PRAGMA schema_version").get() as {
      schema_version: number;
    };
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema_version + 1};`);
  }
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
