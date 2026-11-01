import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData, setEnvironmentData, type Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quarantineAgentDeletionJournal } from "../commands/doctor-agent-deletion-journal-quarantine.js";
import { prepareDoctorDatabaseMigrations } from "../commands/doctor-schema-migrations.js";
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
import { createConformanceWorker } from "../infra/database-engine/conformance.test-support.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import {
  postgresIndexOrderingMigration,
  withLegacyPostgresIndexOrdering,
} from "../infra/database-engine/postgres-index-ordering.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { migrateDaemonRuntimePins } from "../infra/state-migrations.daemon-runtime-pins.js";
import { readMeetingTranscriptMigrationDetectionState } from "../infra/state-migrations.meeting-transcripts-detection.js";
import { createUpdateRunAsync, recordUpdateRunStepAsync } from "../infra/update-run-write.async.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "./openclaw-agent-db-lease.js";
import { repairOpenClawAgentDatabasePaths } from "./openclaw-agent-db-path-repair.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";
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
import { TEMPLATE_STATE_TABLE_RENAMES } from "./openclaw-state-db-schema-v36-template-names.js";
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
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
} from "./openclaw-state-db.postgres-fixture.test-support.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "./openclaw-state-worker-store.js";
import { statePostgresRuntime } from "./postgres-schema.generated/runtime.js";
import { ensureUserBackgroundSchema } from "./user-background.store.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Result = { namespace: string; admissionId: string; catalogReads: number; threadId: number };
function readStateArtifacts(directory: string, pathname: string) {
  const credentialPath = path.join(directory, "client", "credentials.sqlite");
  expect([
    fs.readdirSync(directory).toSorted(),
    fs.readdirSync(path.dirname(pathname)).toSorted(),
    fs.readdirSync(path.dirname(credentialPath)).toSorted(),
  ]).toEqual([["client", "state"], ["openclaw.sqlite"], ["credentials.sqlite"]]);
  return [fs.readFileSync(pathname), fs.readFileSync(credentialPath)];
}

const legacyIndexOrderingSql = withLegacyPostgresIndexOrdering(
  postgresIndexOrderingMigration(
    [statePostgresRuntime.eagerSql, ...statePostgresRuntime.fragments.map(({ sql }) => sql)].join(
      "\n",
    ),
  ),
);
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
// These fixtures start at the successor; restore only empty feature tables from
// the registered predecessor, including CHECK/PK declarations, before old seals.
async function restoreEmptyPredecessorTables(client: pg.Client, previousVersion: number) {
  const source = expectDefined(
    stateEngineSchema.postgresMigrations?.find((step) => step.version === previousVersion + 1)
      ?.fromSchema,
    "Registered historical shared-state schema",
  );
  const eager = expectDefined(source.postgres, "Historical PostgreSQL DDL");
  // DROP COLUMN retains an attnum hole, including at the tail. Recreate the empty
  // receipt tables, retaining incoming foreign keys from installed optional fragments too.
  for (const table of ["worker_environments", "worker_workspace_pending_results"]) {
    expect((await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows).toEqual([
      { n: 0 },
    ]);
    const declaration = expectDefined(
      eager.match(new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`))?.[0],
      `Historical declaration for ${table}`,
    );
    const references = await client.query<{ source: string; definition: string }>(
      `SELECT conrelid::regclass::text AS source, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE contype = 'f' AND confrelid = $1::regclass`,
      [table],
    );
    const dependents = eager.match(
      new RegExp(
        `CREATE (?:UNIQUE )?INDEX [^;]+ ON "${table}"[^;]*;|ALTER TABLE "${table}" ADD FOREIGN KEY[^;]*;`,
        "gu",
      ),
    );
    await client.query(
      `DROP TABLE "${table}" CASCADE; ${declaration} ${dependents?.join("\n") ?? ""}
       ${references.rows.map((ref) => `ALTER TABLE ${ref.source} ADD ${ref.definition};`).join("\n")}`,
    );
  }
  for (const [previous, current] of TEMPLATE_STATE_TABLE_RENAMES) {
    const declaration = expectDefined(
      eager.match(new RegExp(`CREATE TABLE "${previous}" \\([\\s\\S]*?\\n\\);`))?.[0],
      `Historical declaration for ${previous}`,
    );
    expect((await client.query(`SELECT count(*)::int AS n FROM "${current}"`)).rows).toEqual([
      { n: 0 },
    ]);
    await client.query(`DROP TABLE "${current}"; ${declaration}`);
  }
  const present = await client.query(
    "SELECT to_regclass('agent_provenance') IS NOT NULL AS present",
  );
  if (present.rows[0].present) {
    const fragment = expectDefined(
      source.postgresFragments?.find((item) => item.tables.includes("agent_provenance")),
      "Historical optional provenance DDL",
    );
    expect((await client.query("SELECT count(*)::int AS n FROM agent_provenance")).rows).toEqual([
      { n: 0 },
    ]);
    await client.query(`DROP TABLE agent_provenance; ${fragment.sql}`);
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
  it.each(["shared-state", "update-bookkeeping"] as const)(
    "reopens its worker after backend loss without replaying the failed write (%s)",
    async (writer) => {
      const directory = tempDirs.make("state-worker-reconnect-postgres-");
      const pathname = path.join(directory, "state.sqlite");
      const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
      const applicationName = path.basename(directory);
      const workerConnection = new URL(connection!);
      workerConnection.searchParams.set("application_name", applicationName);
      installPostgresStateFixture(workerConnection.href, "state_worker_reconnect");
      const client = new pg.Client({ connectionString: connection });
      await client.connect();
      let namespace: string | undefined;
      const runId = "00000000-0000-4000-8000-000000000001";
      const write = (value: string) =>
        writer === "shared-state"
          ? executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
              type: "machineState.write",
              input: { key: "reconnect.fixture", value },
            })
          : recordUpdateRunStepAsync(
              runId,
              { step: "reconnect.fixture", status: "in_progress", detail: value },
              options,
            );
      const backends = async () =>
        (
          await client.query<{ pid: number; query: string; query_start: Date; state: string }>(
            "SELECT pid, query, query_start, state FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid",
            [applicationName],
          )
        ).rows;
      try {
        namespace = withEngineStoreAdmission(
          () => getPostgresPhysicalFacts(openOpenClawStateDatabase(options).db)?.namespace,
        );
        expect(namespace).toBeDefined();
        await closeOpenClawStateDatabaseAsync();
        let prior: Awaited<ReturnType<typeof backends>> = [];
        if (writer === "update-bookkeeping") {
          const created = await createUpdateRunAsync({ runId, trigger: "cli" }, options);
          expect(created.runId).toBe(runId);
          prior = await backends();
        }
        await write("before");
        const active = await backends();
        // The updater can reuse an idle backend left by run creation.
        const victims = active.filter(
          (row) =>
            !prior.some(
              (kept) =>
                kept.pid === row.pid &&
                kept.query === row.query &&
                kept.query_start.getTime() === row.query_start.getTime(),
            ),
        );
        expect(victims).toHaveLength(1);
        const primary = active.filter((row) => row.pid !== victims[0]!.pid);
        // The updater uses a separate retained writer; leave the primary healthy and unqueried.
        if (writer === "update-bookkeeping") {
          expect(primary.length).toBeGreaterThan(0);
          expect(primary.every((row) => row.state === "idle")).toBe(true);
        }
        const killed = await client.query(
          "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE application_name = $1 AND pid = $2",
          [applicationName, victims[0]!.pid],
        );
        expect(killed.rows).toEqual([{ terminated: true }]);
        expect(
          (await backends()).filter((row) => primary.some((kept) => kept.pid === row.pid)),
        ).toEqual(primary);
        await expect(write("interrupted")).rejects.toSatisfy(hasSqliteWorkerOutcomeUnknown);
        const read = async () => {
          if (writer === "shared-state") {
            const result = await client.query(
              `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = $1`,
              ["reconnect.fixture"],
            );
            return JSON.parse(result.rows[0].value_json);
          }
          const result = await client.query(
            `SELECT steps_json FROM "${namespace}".update_runs WHERE run_id = $1`,
            [runId],
          );
          const steps: Array<{ step: string; detail?: string }> = JSON.parse(
            result.rows[0].steps_json,
          );
          return steps.find((step) => step.step === "reconnect.fixture")?.detail;
        };
        expect(await read()).toBe("before");
        await write("recovered");
        expect(await read()).toBe("recovered");
      } finally {
        await closeOpenClawStateDatabaseAsync();
        await cleanupPostgresStateFixture(client, pathname, namespace);
      }
    },
  );

  it("prunes worker history with bounded UTF-8 ordering and placement protection", async () => {
    const directory = tempDirs.make("state-worker-retention-postgres-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    installPostgresStateFixture(connection!, "state_worker_retention");
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
      await cleanupPostgresStateFixture(client, pathname, namespace);
    }
  });

  it("retains one discovery generation across awaited, nested and native reads", async () => {
    const directory = tempDirs.make("state-composite-snapshot-postgres-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    const pathname = resolveOpenClawStateSqlitePath(env);
    const options = { path: pathname, env };
    installPostgresStateFixture(connection!, "state_composite_snapshot");
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
          return expectDefined(getPostgresPhysicalFacts(db), "PostgreSQL fixture").namespace;
        }, options),
      );
      const artifacts = readStateArtifacts(directory, pathname);
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
      expect(readStateArtifacts(directory, pathname)).toEqual(artifacts);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await cleanupPostgresStateFixture(writer, pathname, namespace);
    }
  });

  it("reads an existing PostgreSQL store while another connection reserves its SQLite anchor", async () => {
    const directory = tempDirs.make("state-anchor-reader-postgres-");
    const pathname = path.join(directory, "state.sqlite");
    const options = { path: pathname, env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
    installPostgresStateFixture(connection!, "state_anchor_reader");
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
      await cleanupPostgresStateFixture(client, pathname, namespace);
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
    installPostgresStateFixture(connection!, "state_doctor_conformance");
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
      await cleanupPostgresStateFixture(client, pathname, namespace);
    }
  });

  it("reads warm and cold discovery state without copying or changing the PostgreSQL anchor", async () => {
    const directory = tempDirs.make("state-discovery-postgres-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    const pathname = resolveOpenClawStateSqlitePath(env);
    const options = { path: pathname, env };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    installPostgresStateFixture(connection!, "state_discovery_conformance");
    let namespace: string | undefined;
    const stateKey = "discovery.fixture";
    const valueJson = JSON.stringify({ source: "PostgreSQL" });
    try {
      namespace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          ensureAgentDatabaseLeaseSchema(db);
          db.exec(`INSERT INTO migration_runs (id, started_at, status, report_json)
            VALUES ('meeting-import', 1, 'imported', '{}');
            INSERT INTO migration_sources
            (source_key, migration_kind, source_path, target_table, last_run_id, status, imported_at, report_json)
            VALUES ('meeting-import', 'meeting-transcripts-files-v1', 'synthetic', 'meeting_transcript_sessions', 'meeting-import', 'imported', 1, '{}');`);
          db.prepare(
            "INSERT INTO agent_database_leases (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at) VALUES (?, ?, ?, ?, NULL, ?)",
          ).run("diagnostic-lease", "main", path.join(directory, "agent.sqlite"), process.pid, 1);
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          ).run(stateKey, valueJson, 1);
          return expectDefined(getPostgresPhysicalFacts(db), "PostgreSQL fixture").namespace;
        }, options),
      );
      const artifacts = readStateArtifacts(directory, pathname);
      let prepared: Promise<{ changes: string[]; warnings: string[] }> | undefined;
      withEngineStoreAdmission(() => {
        prepared = prepareOpenClawStateDatabaseSchema(options, "doctor-preparation");
        for (const repair of [
          repairOpenClawStateDatabaseIndexesForDoctor,
          repairOpenClawStateDatabaseReadabilityForDoctor,
        ]) {
          expect(repair(options)).toEqual({ changes: [], warnings: [] });
        }
      });
      expect(await prepared).toEqual({ changes: [], warnings: [] });
      for (const source of ["warm", "cold"]) {
        if (source === "cold") {
          await closeOpenClawStateDatabaseAsync();
        }
        withEngineStoreAdmission(() => {
          expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
          for (const artifactPreservingReadOnly of [false, true]) {
            expect(
              readMeetingTranscriptMigrationDetectionState({ env, artifactPreservingReadOnly })
                .pendingImportCount,
            ).toBe(1);
          }
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
        expect(readStateArtifacts(directory, pathname)).toEqual(artifacts);
      }
      using anchor = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(
        anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([{ name: "openclaw_engine_anchor" }]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await cleanupPostgresStateFixture(client, pathname, namespace);
    }
  });

  it.each([25, 26, 27, 28])(
    "migrates version %i while preserving heads, leases, lazy fragments and publication intent",
    async (previousVersion) => {
      const directory = tempDirs.make("state-layout-postgres-");
      const pathname = path.join(directory, "state", "openclaw.sqlite");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: directory,
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
      };
      fs.writeFileSync(
        env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({ database: { engine: "postgres", postgres: { connection } } }),
      );
      const options = { path: pathname, env };
      const client = new pg.Client({ connectionString: connection });
      await client.connect();
      installPostgresStateFixture(connection!, "state_layout_conformance");
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
        await restoreEmptyPredecessorTables(client, previousVersion);
        if (previousVersion < 28) {
          await restorePublicationSchemaV27(client);
        }
        await client.query(legacyPublicationInsert);
        await client.query(`
        ${statePostgresRuntime.clientCredentialSource.sql}
        ${legacyIndexOrderingSql}
        ${previousVersion < 27 ? legacyWriteIndexesSql : ""}
        UPDATE schema_meta SET schema_version = ${previousVersion};
        UPDATE config_machine_state SET value_json = '${previousVersion}'
          WHERE state_key = 'state.schema.contentVersion';
        UPDATE openclaw_schema_meta
          SET version = ${previousVersion}, fingerprint = NULL, ddl_hash = NULL, server_major = NULL;
        COMMIT;`);
        const retainedPublication = await client.query(
          `SELECT * FROM "${namespace}".github_publication_requests WHERE request_id = 'retained-publication'`,
        );
        const lock = await acquireGatewayLock({
          env,
          allowInTests: true,
          role: "sqlite-maintenance",
          timeoutMs: 0,
        });
        expect(lock).not.toBeNull();
        try {
          const migration = await lock!.run(() =>
            prepareDoctorDatabaseMigrations({
              env,
              databasePaths: [pathname],
              pendingDatabasePaths: [pathname],
              pendingMigrations: [
                {
                  kind: "state",
                  path: pathname,
                  foundVersion: previousVersion,
                  supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
                },
              ],
            }),
          );
          expect(migration.warnings).toEqual([]);
        } finally {
          await lock!.release();
        }
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
        await cleanupPostgresStateFixture(client, pathname, namespace);
      }
    },
  );

  it("bootstraps, migrates authority metadata, retains lazy fragments, reuses admission and closes paired handles", async () => {
    const directory = tempDirs.make("state-postgres-");
    const pathname = path.join(directory, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
    };
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({ database: { engine: "postgres", postgres: { connection } } }),
    );
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
        worker = createConformanceWorker(
          url,
          {
            path: pathname,
            env,
            mode,
            admissions: captureSqliteDatabaseAdmissions(undefined, { location: pathname }),
          },
          { connection: connection! },
        );
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
      await restoreEmptyPredecessorTables(client, 24);
      await restorePublicationSchemaV27(client);
      await client.query(`
        ${statePostgresRuntime.clientCredentialSource.sql}
        ${legacyIndexOrderingSql}
        ${legacyWriteIndexesSql}
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
    installPostgresStateFixture(connection!, "pin_conformance");
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
