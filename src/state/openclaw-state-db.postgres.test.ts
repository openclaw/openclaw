import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData, setEnvironmentData, Worker } from "node:worker_threads";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quarantineAgentDeletionJournal } from "../commands/doctor-agent-deletion-journal-quarantine.js";
import {
  commitDaemonRuntimePin,
  readDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
  readDaemonRuntimePinMigrationPending,
  withDaemonRuntimePinMigration,
} from "../daemon/runtime-pin-state.js";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { createWorkerEnvironmentStore } from "../gateway/worker-environments/store.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { migrateDaemonRuntimePins } from "../infra/state-migrations.daemon-runtime-pins.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "./openclaw-agent-db-lease.js";
import { repairOpenClawAgentDatabasePaths } from "./openclaw-agent-db-path-repair.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  ensureAgentDatabaseLeaseSchema,
  ensureGitHubPublicationSchema,
  ensurePersonalGitHubPublicationSchema,
  ensureRepositoryGitHubPublicationSchema,
  ensureAgentDeletionJournalPhaseSchema,
} from "./openclaw-state-db-schema-additive.js";
import { withLegacyPublicationDraft } from "./openclaw-state-db-schema-v28-publication.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseByPathAsync,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { statePostgresRuntime } from "./postgres-schema.generated/runtime.js";
import { ensureUserBackgroundSchema } from "./user-background.store.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Result = { namespace: string; admissionId: string; catalogReads: number; threadId: number };
const legacyWriteIndexesSql = `
  DROP INDEX idx_state_leases_owner;
  ${statePostgresRuntime.preWriteIndexesV27Sql.state_leases}
  ${statePostgresRuntime.preWriteIndexesV27Sql.skill_usage}
  ${statePostgresRuntime.preWriteIndexesV27Sql.acp_replay_events}
`;

// Dropping a column leaves an attnum hole; rebuild only these empty fixture tables
// so the predecessor and migrated catalogs retain their real column positions.
async function restorePublicationSchemaV27(client: pg.Client) {
  for (const table of [
    "github_publication_requests",
    "github_personal_publication_requests",
    "github_repository_publication_requests",
  ]) {
    const result = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [table]);
    if (!result.rows[0].present) {
      continue;
    }
    const fragment = statePostgresRuntime.fragments.find((entry) => entry.tables.includes(table));
    if (!fragment) {
      throw new Error("Missing publication fixture schema");
    }
    await client.query(`DROP TABLE ${table}; ${withLegacyPublicationDraft(fragment.sql)}`);
  }
}
const legacyPublicationInsert = `INSERT INTO github_publication_requests
  (request_id, idempotency_key, request_digest, session_id, session_key, agent_id,
    worktree_id, repository_fingerprint, identity_source, identity_account_id,
    identity_login, status, branch, created_at_ms, updated_at_ms)
  VALUES ('retained-publication', 'accepted',
    'beda069ac7c4479d5f27d419da7a1c81073d1494f373ab8059f0558ca9ca415c',
    'publication-migration', 'agent:main:publication', 'main', 'worktree', 'repository',
    'system-detected', 42, 'publisher', 'requested', 'topic', 1, 1)`;

describe.skipIf(!connection)("PostgreSQL shared-state owner", () => {
  it("prunes worker history with bounded UTF-8 ordering and placement protection", async () => {
    const directory = tempDirs.make("state-worker-retention-postgres-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "state_worker_retention" },
    });
    let namespace: string | undefined;
    const referencedId = "worker-000-reference";
    const laterId = "worker-\u{10000}";
    const firstId = "worker-\ue000";
    try {
      const database = withEngineStoreAdmission(() => openOpenClawStateDatabase(options));
      namespace = getPostgresPhysicalFacts(database.db)?.namespace;
      expect(namespace).toBeDefined();
      let store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
      for (const environmentId of [referencedId, laterId, firstId]) {
        await store.createIntent({
          environmentId,
          providerId: "fixture",
          profileId: "development",
          profileSnapshot: { settings: {} },
          provisionOperationId: `provision:${environmentId}`,
        });
        await store.transition({ environmentId, from: "requested", to: "failed" });
      }
      await store.close();
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(`INSERT INTO worker_session_placements (
              session_id, agent_id, session_key, state, environment_id, recovery_error,
              created_at_ms, updated_at_ms, state_changed_at_ms
            ) VALUES ('retained-session', 'main', 'retained-key', 'failed', ?,
              'worker unavailable', 1, 1, 1)`).run(referencedId);
          },
          { database },
        ),
      );
      store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
      const nowMs = 10 * 24 * 60 * 60 * 1_000;
      expect(await store.pruneTerminalEnvironments({ nowMs, limit: 1 })).toBe(1);
      expect(store.get(firstId)).toBeUndefined();
      expect(store.get(laterId)?.state).toBe("failed");
      expect(store.get(referencedId)?.state).toBe("failed");
      expect(await store.pruneTerminalEnvironments({ nowMs })).toBe(1);
      expect(store.list().map((record) => record.environmentId)).toEqual([referencedId]);
      expect(
        (await client.query(`SELECT environment_id FROM "${namespace}".worker_environments`)).rows,
      ).toEqual([{ environment_id: referencedId }]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      retireSqliteDatabaseAdmissionForPath(pathname);
      resetDatabaseEngineSelectionForTest();
      try {
        if (namespace) {
          await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  });

  it("retains one discovery generation across awaited, nested and native reads", async () => {
    const directory = tempDirs.make("state-composite-snapshot-postgres-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "state_composite_snapshot" },
    });
    const writer = new pg.Client({ connectionString: connection });
    await writer.connect();
    let namespace: string | undefined;
    const stateKey = "discovery.generation";
    const read = async (current = false) =>
      (
        await executeExistingOpenClawStateRead(
          options,
          { type: "tui.lastSession.read", stateKey },
          { current },
        )
      )?.row?.value_json;
    try {
      namespace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
            stateKey,
            "before",
            1,
          );
          return getPostgresPhysicalFacts(db)?.namespace;
        }, options),
      );
      expect(namespace).toBeDefined();
      const anchor = fs.readFileSync(pathname);
      await withOpenClawStateDatabaseReadSnapshot(async () => {
        expect(await read()).toBe("before");
        await writer.query(
          `UPDATE "${namespace}".config_machine_state SET value_json = $1 WHERE state_key = $2`,
          ["after", stateKey],
        );
        expect(await read()).toBe("before");
        await withOpenClawStateDatabaseReadSnapshot(async () => {
          expect(await read()).toBe("before");
          expect(
            withEngineStoreAdmission(() =>
              withExistingOpenClawStateDatabaseReadOnly(
                ({ db }) =>
                  db
                    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
                    .get(stateKey)?.value_json,
                options,
              ),
            ),
          ).toBe("before");
        }, options);
        expect(await read(true)).toBe("after");
      }, options);
      expect(await read()).toBe("after");
      expect(fs.readFileSync(pathname)).toEqual(anchor);
      expect(fs.readdirSync(directory)).toEqual(["state.sqlite"]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      retireSqliteDatabaseAdmissionForPath(pathname);
      resetDatabaseEngineSelectionForTest();
      try {
        if (namespace) {
          await writer.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await writer.end();
      }
    }
  });

  it("reads an existing PostgreSQL store while another connection reserves its SQLite anchor", async () => {
    const directory = tempDirs.make("state-anchor-reader-postgres-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "state_anchor_reader" },
    });
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    try {
      namespace = withEngineStoreAdmission(
        () => getPostgresPhysicalFacts(openOpenClawStateDatabase(options).db)?.namespace,
      );
      expect(namespace).toBeDefined();
      closeOpenClawStateDatabaseForTest();
      retireSqliteDatabaseAdmissionForPath(pathname);
      using writer = openNodeSqliteDatabase(pathname);
      writer.exec("BEGIN IMMEDIATE");
      try {
        const read = await executeExistingOpenClawStateRead(
          options,
          { type: "agentDatabaseRegistry.read" },
          { current: true },
        );
        expect(read?.result).toEqual({ status: "available", entries: [] });
      } finally {
        writer.exec("ROLLBACK");
      }
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      retireSqliteDatabaseAdmissionForPath(pathname);
      resetDatabaseEngineSelectionForTest();
      try {
        if (namespace) {
          await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  });

  it("leaves healthy Doctor journal and registry state alone and refuses native repairs", async () => {
    const directory = tempDirs.make("state-doctor-postgres-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    const options = { env };
    const pathname = resolveOpenClawStateSqlitePath(env);
    const ordinary = path.join(directory, "agents", "main", "agent", "openclaw-agent.sqlite");
    const sentinel = path.join(directory, "(multiple).sqlite");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "state_doctor_conformance" },
    });
    let namespace: string | undefined;
    const inspectJournal = () => {
      let inspection: ReturnType<typeof quarantineAgentDeletionJournal> | undefined;
      withEngineStoreAdmission(() => {
        inspection = quarantineAgentDeletionJournal({ inventory: [], configuredTargets: [], env });
      });
      return inspection;
    };
    try {
      namespace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          ensureAgentDeletionJournalPhaseSchema(db);
          db.prepare(`INSERT INTO agent_deletion_journal
            (agent_id, operation_id, agent_dir, workspace_dir, sessions_dir, created_at)
            VALUES ('retired', 'doctor-fixture', ?, ?, ?, 1)`).run(
            path.join(directory, "agents", "retired", "agent"),
            path.join(directory, "workspace"),
            path.join(directory, "agents", "retired", "sessions"),
          );
          db.prepare("INSERT INTO agent_databases VALUES ('main', ?, 26, 1, 0)").run(ordinary);
          return getPostgresPhysicalFacts(db)?.namespace;
        }, options),
      );
      expect(namespace).toBeDefined();
      const anchorBytes = fs.readFileSync(pathname);
      await expect(inspectJournal()).resolves.toBeUndefined();
      expect(
        withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(repairOpenClawAgentDatabasePaths, options),
        ),
      ).toEqual({ repaired: 0, warnings: [] });

      fs.writeFileSync(sentinel, "preserved native repair candidate");
      await client.query(
        `INSERT INTO "${namespace}".agent_databases VALUES ('main', $1, 26, 1, 0)`,
        [sentinel],
      );
      const registrations = await client.query(`SELECT * FROM "${namespace}".agent_databases`);
      expect(() =>
        withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(repairOpenClawAgentDatabasePaths, options),
        ),
      ).toThrow("PostgreSQL cannot use SQLite repair");
      expect(fs.readFileSync(sentinel, "utf8")).toBe("preserved native repair candidate");
      expect((await client.query(`SELECT * FROM "${namespace}".agent_databases`)).rows).toEqual(
        registrations.rows,
      );

      await client.query(
        `UPDATE "${namespace}".agent_deletion_journal SET database_paths_json = '[1]'`,
      );
      const journal = await client.query(`SELECT * FROM "${namespace}".agent_deletion_journal`);
      await expect(inspectJournal()).rejects.toThrow("PostgreSQL cannot use SQLite repair");
      expect(
        (await client.query(`SELECT * FROM "${namespace}".agent_deletion_journal`)).rows,
      ).toEqual(journal.rows);
      expect(fs.readFileSync(pathname)).toEqual(anchorBytes);
      expect(fs.existsSync(path.join(directory, "agents"))).toBe(false);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      retireSqliteDatabaseAdmissionForPath(pathname);
      resetDatabaseEngineSelectionForTest();
      try {
        if (namespace) {
          await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  });

  it("reads warm and cold discovery state without copying or changing the PostgreSQL anchor", async () => {
    const directory = tempDirs.make("state-discovery-postgres-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "state_discovery_conformance" },
    });
    let namespace: string | undefined;
    const stateKey = "discovery.fixture";
    const valueJson = JSON.stringify({ source: "PostgreSQL" });
    try {
      namespace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          ensureAgentDatabaseLeaseSchema(db);
          db.prepare(
            "INSERT INTO agent_database_leases (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at) VALUES (?, ?, ?, ?, NULL, ?)",
          ).run("diagnostic-lease", "main", path.join(directory, "agent.sqlite"), process.pid, 1);
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          ).run(stateKey, valueJson, 1);
          return getPostgresPhysicalFacts(db)?.namespace;
        }, options),
      );
      expect(namespace).toBeDefined();
      const anchorBytes = fs.readFileSync(pathname);
      let prepared: Promise<{ changes: string[]; warnings: string[] }> | undefined;
      withEngineStoreAdmission(() => {
        prepared = prepareOpenClawStateDatabaseSchema(options, "doctor-preparation");
        expect(repairOpenClawStateDatabaseIndexesForDoctor(options)).toEqual({
          changes: [],
          warnings: [],
        });
        expect(repairOpenClawStateDatabaseReadabilityForDoctor(options)).toEqual({
          changes: [],
          warnings: [],
        });
      });
      expect(await prepared).toEqual({ changes: [], warnings: [] });
      for (const source of ["warm", "cold"]) {
        if (source === "cold") {
          await closeOpenClawStateDatabaseAsync();
        }
        withEngineStoreAdmission(() => {
          expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
          expect(
            readActiveOpenClawAgentDatabaseLeasesReadOnly(
              options,
              openDoctorStateSchemaReadAdmission,
            ).map((row) => row.lease_id),
          ).toEqual(["diagnostic-lease"]);
        });
        const reply = await withArtifactPreservingStateReads(() =>
          withOpenClawStateDatabaseReadSnapshot(
            () =>
              executeExistingOpenClawStateRead(options, { type: "tui.lastSession.read", stateKey }),
            options,
          ),
        );
        expect(reply?.row).toEqual({ value_json: valueJson, updated_at_ms: 1 });
        expect(fs.readFileSync(pathname)).toEqual(anchorBytes);
        expect(fs.readdirSync(directory)).toEqual(["state.sqlite"]);
      }
      using anchor = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(
        anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([{ name: "openclaw_engine_anchor" }]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      retireSqliteDatabaseAdmissionForPath(pathname);
      resetDatabaseEngineSelectionForTest();
      try {
        if (namespace) {
          await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
        }
      } finally {
        await client.end();
      }
    }
  });

  it.each([25, 26, 27])(
    "migrates version %i while preserving heads, leases, lazy fragments and publication intent",
    async (previousVersion) => {
      const directory = tempDirs.make("state-layout-postgres-");
      const pathname = path.join(directory, "state.sqlite");
      const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
      const client = new pg.Client({ connectionString: connection });
      await client.connect();
      installDatabaseEngineSelection({
        effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
        postgres: { connection: connection!, schemaPrefix: "state_layout_conformance" },
      });
      let namespace: string | undefined;
      try {
        const facts = withEngineStoreAdmission(() =>
          runOpenClawStateWriteTransaction(({ db }) => {
            ensureUserBackgroundSchema(options);
            ensureGitHubPublicationSchema(db);
            ensurePersonalGitHubPublicationSchema(db);
            ensureRepositoryGitHubPublicationSchema(db);
            db.prepare(`INSERT INTO session_state_heads
            (session_key, agent_id, last_sequence, pruned_max_sequence, updated_at)
            VALUES (?, ?, ?, ?, ?)`).run("shared-key", "main", 7, 3, 11);
            db.prepare(`INSERT INTO session_state_heads
            (session_key, agent_id, last_sequence, pruned_max_sequence, updated_at)
            VALUES (?, ?, ?, ?, ?)`).run("shared-key", "other", 19, 5, 23);
            db.prepare(`INSERT INTO state_leases
            (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
            VALUES ('synthetic', 'retained', 'owner', 10000, 100, '{}', 100, 100)`).run();
            return getPostgresPhysicalFacts(db);
          }, options),
        );
        if (!facts) {
          throw new Error("State layout fixture did not select PostgreSQL");
        }
        namespace = facts.namespace;
        const retained = await client.query(
          `SELECT * FROM "${namespace}".session_state_heads ORDER BY agent_id`,
        );
        const retainedLease = await client.query(
          `SELECT * FROM "${namespace}".state_leases WHERE scope = 'synthetic'`,
        );

        const currentIndexes = await client.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
          AND tablename IN ('acp_replay_events', 'skill_usage', 'state_leases') ORDER BY indexname`,
          [namespace],
        );
        closeOpenClawStateDatabaseForTest();
        retireSqliteDatabaseAdmissionForPath(pathname);
        // Restore the actual historical catalog before relabeling metadata.
        await client.query(`BEGIN; SET LOCAL search_path TO "${namespace}";`);
        await restorePublicationSchemaV27(client);
        await client.query(legacyPublicationInsert);
        await client.query(`${previousVersion < 27 ? legacyWriteIndexesSql : ""}
        UPDATE schema_meta SET schema_version = ${previousVersion};
        UPDATE config_machine_state SET value_json = '${previousVersion}'
          WHERE state_key = 'state.schema.contentVersion';
        UPDATE openclaw_schema_meta
          SET version = ${previousVersion}, fingerprint = NULL, ddl_hash = NULL, server_major = NULL;
        COMMIT;`);
        const retainedPublication = await client.query(
          `SELECT * FROM "${namespace}".github_publication_requests WHERE request_id = 'retained-publication'`,
        );
        withEngineStoreAdmission(() => {
          const upgraded = openOpenClawStateDatabase(options);
          for (const table of [
            "github_publication_requests",
            "github_personal_publication_requests",
            "github_repository_publication_requests",
          ]) {
            expect(() => upgraded.db.prepare(`SELECT draft FROM ${table}`).all()).not.toThrow();
          }
          expect(getPostgresPhysicalFacts(upgraded.db)?.version).toBe(
            OPENCLAW_STATE_SCHEMA_VERSION,
          );
          expect(
            upgraded.db
              .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
              .get(),
          ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
          expect(
            upgraded.db
              .prepare(
                "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
              )
              .get(),
          ).toEqual({ value_json: String(OPENCLAW_STATE_SCHEMA_VERSION) });
          expect(
            upgraded.db
              .prepare(
                "SELECT version, fingerprint, ddl_hash, server_major FROM openclaw_schema_meta",
              )
              .get(),
          ).toEqual({
            version: OPENCLAW_STATE_SCHEMA_VERSION,
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
            ddl_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
            server_major: facts.capabilities.serverMajor,
          });
        });
        expect(
          (await client.query(`SELECT * FROM "${namespace}".session_state_heads ORDER BY agent_id`))
            .rows,
        ).toEqual(retained.rows);
        expect(
          (
            await client.query(
              `SELECT * FROM "${namespace}".state_leases WHERE scope = 'synthetic'`,
            )
          ).rows,
        ).toEqual(retainedLease.rows);
        expect(
          (
            await client.query(
              `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
            AND tablename IN ('acp_replay_events', 'skill_usage', 'state_leases') ORDER BY indexname`,
              [namespace],
            )
          ).rows,
        ).toEqual(currentIndexes.rows);
        expect(
          (
            await client.query(
              `SELECT * FROM "${namespace}".github_publication_requests WHERE request_id = 'retained-publication'`,
            )
          ).rows,
        ).toEqual([{ ...retainedPublication.rows[0], draft: null }]);
        expect(
          (await client.query(`SELECT * FROM "${namespace}".user_background_images`)).rows,
        ).toEqual([]);
        closeOpenClawStateDatabaseForTest();
        retireSqliteDatabaseAdmissionForPath(pathname);
        withEngineStoreAdmission(() => {
          const reopened = openOpenClawStateDatabase(options);
          expect(getPostgresPhysicalFacts(reopened.db)?.version).toBe(
            OPENCLAW_STATE_SCHEMA_VERSION,
          );
        });
      } finally {
        closeOpenClawStateDatabaseForTest();
        retireSqliteDatabaseAdmissionForPath(pathname);
        resetDatabaseEngineSelectionForTest();
        try {
          if (namespace) {
            await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
          }
        } finally {
          await client.end();
        }
      }
    },
  );

  it("bootstraps, migrates authority metadata, retains lazy fragments, reuses admission and closes paired handles", async () => {
    const pathname = path.join(tempDirs.make("state-postgres-"), "state.sqlite");
    const run = async (mode: "bootstrap" | "restart" | "migrate") => {
      const anchor = openNodeSqliteDatabase(pathname);
      admitSqliteSchema(anchor);
      const url = resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: "openclaw-state-db.postgres.test-support",
        distWorkerPath: "state/openclaw-state-db.postgres.test-support.js",
      });
      const previous = getEnvironmentData("openclaw.test.state.connection");
      let worker: Worker;
      try {
        setEnvironmentData("openclaw.test.state.connection", connection);
        worker = new Worker(url, {
          execArgv: resolveRuntimeWorkerThreadExecArgv(url),
          workerData: {
            path: pathname,
            mode,
            admissions: captureSqliteDatabaseAdmissions(undefined, { location: pathname }),
          },
        });
      } finally {
        setEnvironmentData("openclaw.test.state.connection", previous);
      }
      try {
        return await new Promise<Result>((resolve, reject) => {
          let result: Result | { error: string } | undefined;
          worker.on("message", (message: Result | { error: string }) => {
            result = message;
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0 || !result) {
              reject(new Error(`State worker exited ${code} without a result`));
            } else if ("error" in result) {
              reject(new Error(result.error));
            } else {
              resolve(result);
            }
          });
        });
      } finally {
        await worker.terminate();
        anchor.close();
        retireSqliteDatabaseAdmissionForPath(pathname);
      }
    };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    try {
      const cold = await run("bootstrap");
      namespace = cold.namespace;
      expect(cold.threadId).not.toBe(0);
      await client.query(`SET search_path = "${namespace}"`);
      await client.query("BEGIN");
      await restorePublicationSchemaV27(client);
      await client.query(`${legacyWriteIndexesSql}
        UPDATE openclaw_schema_meta
          SET version = 24, fingerprint = NULL, ddl_hash = NULL, server_major = NULL
          WHERE store = 'state';
        UPDATE schema_meta SET schema_version = 24 WHERE meta_key = 'primary';
        UPDATE config_machine_state SET value_json = '24'
          WHERE state_key = 'state.schema.contentVersion';
        INSERT INTO subagent_runs
          (run_id, child_session_key, requester_session_key, created_at, payload_json)
          VALUES ('retained-child', 'agent:main:subagent:retained', 'agent:main:main', 1,
            '{"completion":{"resultText":"Interrupted by Gateway restart"}}');
        COMMIT;`);
      const retained = (await client.query("SELECT * FROM subagent_runs")).rows;
      expect((await run("migrate")).namespace).toBe(namespace);
      expect((await client.query("SELECT * FROM subagent_runs")).rows).toEqual(retained);
      expect(
        (
          await client.query(
            "SELECT version::int AS version FROM openclaw_schema_meta WHERE store = 'state'",
          )
        ).rows,
      ).toEqual([{ version: OPENCLAW_STATE_SCHEMA_VERSION }]);
      const restart = await run("restart");
      expect(restart.namespace).toBe(cold.namespace);
      expect(restart.admissionId).not.toBe(cold.admissionId);
      await client.query(`UPDATE "${namespace}".schema_meta SET schema_version = $1`, [
        OPENCLAW_STATE_SCHEMA_VERSION + 1,
      ]);
      await expect(run("restart")).rejects.toThrow("PostgreSQL state metadata mismatch");
      await client.query(`DROP TABLE "${namespace}".secret_store_entries`);
      await expect(run("restart")).rejects.toThrow("PostgreSQL schema drift detected");
    } finally {
      if (!namespace) {
        const anchor = openNodeSqliteDatabase(pathname);
        try {
          const present = anchor
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'openclaw_engine_anchor'")
            .get();
          const value = present
            ? anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema
            : undefined;
          if (typeof value === "string") {
            namespace = value;
          }
        } finally {
          anchor.close();
        }
      }
      if (namespace) {
        await client.query(`DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`);
      }
      await client.end();
    }
  });
});

describe.skipIf(!connection)("PostgreSQL local runtime pins", () => {
  const directories = useAutoCleanupTempDirTracker(afterAll);
  const client = new pg.Client({ connectionString: connection });
  let env: NodeJS.ProcessEnv;
  let namespace: string;

  beforeAll(async () => {
    await client.connect();
    env = { ...process.env, OPENCLAW_STATE_DIR: directories.make("pin-postgres-") };
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "pin_conformance" },
    });
    namespace = withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const facts = getPostgresPhysicalFacts(db);
          if (!facts) {
            throw new Error("Runtime pin fixture did not select PostgreSQL");
          }
          return facts.namespace;
        },
        { env },
      ),
    );
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    resetDatabaseEngineSelectionForTest();
    try {
      if (namespace) {
        await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  });

  it("keeps status, install and update intent local without accessing PostgreSQL pins", async () => {
    const statements: { engine: string; sql: string }[] = [];
    const observation = channel("openclaw.database.statement");
    const observe = (event: unknown) => {
      if (
        event &&
        typeof event === "object" &&
        "engine" in event &&
        typeof event.engine === "string" &&
        "sql" in event &&
        typeof event.sql === "string"
      ) {
        statements.push({ engine: event.engine, sql: event.sql });
      }
    };
    observation.subscribe(observe);
    try {
      // Prove capture observes the selected shared-state owner before pin operations.
      withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            db
              .prepare("SELECT state_key FROM config_machine_state WHERE state_key = ?")
              .get("state.schema.contentVersion"),
          { env },
        ),
      );
      expect(
        statements.some(
          ({ engine, sql }) => engine === "postgres" && sql.includes("config_machine_state"),
        ),
      ).toBe(true);
      statements.length = 0;

      const scope = { kind: "gateway" as const, env };
      const pin = { runtime: "node" as const, path: "/runtime tools/node" };
      const command = { programArguments: [pin.path, "/app/openclaw.mjs", "gateway"] };
      expect(readDaemonRuntimePinMigrationPending(env)).toBe(false);
      expect(readDaemonRuntimePin(scope, command).stored).toBe(false);
      expect(
        withDaemonRuntimePinStore(env, false, (db) =>
          db.prepare("SELECT * FROM daemon_runtime_pin_migration").get(),
        ),
      ).toEqual({
        version: 1,
        source_state: "none/unshipped",
        phase: "complete",
        updated_at: expect.any(Number),
      });
      expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
      await withDaemonRuntimePinMigration(env, () => {
        const expected = readDaemonRuntimePinForInstall(scope, command, true);
        commitDaemonRuntimePin(scope, { expected, pin }, command);
      });
      // The native CLI projection deliberately skips config/engine startup.
      resetDatabaseEngineSelectionForTest();
      const status = readDaemonRuntimePin(scope, command);
      expect(status).toMatchObject({ stored: true, pin, definition: expect.any(String) });
      expect(
        await withDaemonRuntimePinMigration(env, () => readDaemonRuntimePin(scope, command)),
      ).toEqual(status);
      expect(readDaemonRuntimePinMigrationPending(env)).toBe(false);
      expect(
        statements.filter(
          ({ engine, sql }) => engine === "postgres" || sql.includes("config_machine_state"),
        ),
      ).toEqual([]);
    } finally {
      observation.unsubscribe(observe);
    }
  });
});
