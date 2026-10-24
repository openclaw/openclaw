import fs from "node:fs";
import "./backup-worker.test-support.js";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { recordUpdateDatabaseWrites } from "../../cli/update-cli/update-command-database-receipts.js";
import { prepareDoctorDatabaseMigrations } from "../../commands/doctor-schema-migrations.js";
import { repairLegacySessionEntryStates } from "../../commands/doctor-session-delivery-state.js";
import {
  preparePostgresRestore,
  readBackupEngine,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
import { agentEngineSchema, openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { preflightOpenClawDatabaseSchemas } from "../../state/openclaw-database-preflight.js";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import { withOpenClawStateReadOnlyLocation } from "../../state/openclaw-state-db-read-connection.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createMockStateReadSource } from "../../state/openclaw-state-read-mock.test-support.js";
import type * as StateReadWorker from "../../state/openclaw-state-read-worker.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
} from "../../state/openclaw-state-read.types.js";
import { stateBootstrapReadOperations } from "../../state/state-bootstrap-read.worker.js";
import { acquireGatewayLock } from "../gateway-lock.js";
import { inspectGatewayOwnerLease } from "../gateway-owner-lease.worker.js";
import { defaultPayload } from "../gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { createUpdateDatabaseBackup } from "../update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../update-database-restore.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../update-doctor-result.js";
import { createUpdateRun, recordUpdateRunPhase } from "../update-run-ledger.js";
import { installDatabaseProcessRole, withEngineStoreAdmission } from "./admission-scope.js";
import { createUpdateDatabaseBackupWithFixtureTransport } from "./backup-capture.test-support.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore } from "./open.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import type { PortDescriptor } from "./port-descriptor.js";
import { postgresCatalogQuery, readPostgresCatalog } from "./postgres-catalog.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";
import { statePortProvider } from "./state-port.js";

// Keep the actual read contracts in-process so all consumers see the
// synthetic migration registration.
const reads = vi.hoisted(() => ({
  capture: vi.fn<typeof StateReadWorker.captureOpenClawStateReadSource>(),
  retire: vi.fn<typeof StateReadWorker.retireIdleOpenClawStateReadWorkers>(),
}));
// mock-isolation: Install transport before cyclic state imports so the synthetic migration stays in-process.
vi.mock("../../state/openclaw-state-read-worker.js", () => ({
  captureOpenClawStateReadSource: reads.capture,
  retireIdleOpenClawStateReadWorkers: reads.retire,
}));

async function readInProcess(command: OpenClawStateReadCommand, source: OpenClawStateReadLocation) {
  const databasePath = source.context.admission.databasePath;
  if (command.type === "stateBootstrap.inspect" || command.type === "stateBootstrap.ownership") {
    return withEngineStoreAdmission(() =>
      withOpenClawStateReadOnlyLocation(
        ({ db }) => ({
          ok: true as const,
          sourceAdmitted: true as const,
          ...(command.type === "stateBootstrap.inspect"
            ? stateBootstrapReadOperations[command.type](command.input, db)
            : stateBootstrapReadOperations[command.type](command.input, db)),
        }),
        databasePath,
        source.location,
      ),
    );
  }
  if (command.type !== "gatewayOwnerLease.read") {
    throw new Error(`Unexpected fixture read: ${command.type}`);
  }
  const lease = withEngineStoreAdmission(() =>
    inspectGatewayOwnerLease({ ...source, databasePath }, () => {}, command.schemaMaintenance),
  );
  return { ok: true as const, type: command.type, sourceAdmitted: true as const, lease };
}

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("Doctor PostgreSQL version migration", () => {
  const client = new Client({ connectionString: connection });
  const namespaces = new Set<string>();
  const target = stateEngineSchema.version;
  const originalMigrations = stateEngineSchema.postgresMigrations;
  let env: NodeJS.ProcessEnv;
  let pathname: string;
  let namespace: string;
  let predecessor: StoreSchema;
  let backup: PortDescriptor;
  let targetFingerprint: unknown;
  let targetAgentCatalog: string[];
  const config = {
    database: { engine: "postgres" as const, postgres: { connection: connection! } },
  };
  const readRows = async () =>
    (
      await client.query(
        `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'doctor.fixture'`,
      )
    ).rows;
  const readMeta = async () =>
    (await client.query(`SELECT version, fingerprint FROM "${namespace}".openclaw_schema_meta`))
      .rows[0];
  const archives = () =>
    fs.readdirSync(path.dirname(pathname)).filter((name) => name.endsWith(".postgres.bak"));

  function admit(schema: StoreSchema, file = pathname, existingOnly = true) {
    return withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(file);
      const db = openEngineStore({
        anchor,
        schema,
        input: { connection: connection!, schemaPrefix: "doctor_fixture" },
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: true }),
        prepareAnchor() {},
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
        existingOnly,
      });
      try {
        return getPostgresPhysicalFacts(db);
      } finally {
        db.close();
      }
    });
  }

  // Fingerprints include namespace-qualified definitions; compare catalogs after relocation.
  const readAgentCatalog = async (schema: string) =>
    readPostgresCatalog((await client.query(postgresCatalogQuery(schema, true))).rows[0].catalog)
      .map((fact) => JSON.stringify(fact).replaceAll(schema, "fixture_namespace"))
      .toSorted();

  beforeAll(async () => {
    const worker = await vi.importActual<typeof StateReadWorker>(
      "../../state/openclaw-state-read-worker.js",
    );
    reads.retire.mockImplementation(worker.retireIdleOpenClawStateReadWorkers);
    reads.capture.mockImplementation(() => ({
      own: () => () => {},
      createTransport: (command) =>
        createMockStateReadSource({
          read: async (source) => ({ value: await readInProcess(command, source) }),
          async close() {},
        }).createTransport(command),
    }));
    await client.connect();
    installDatabaseProcessRole("cli-oneshot");
    env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("doctor-pg-migration-") };
    pathname = resolveOpenClawStateSqlitePath(env);
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "doctor_fixture" },
    });
    namespace = withEngineStoreAdmission(() =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          expect(isPostgresSqlConnection(db)).toBe(true);
          return getPostgresPhysicalFacts(db)!.namespace;
        },
        { env },
      ),
    );
    namespaces.add(namespace);
    closeOpenClawStateDatabaseForTest();
    targetFingerprint = (await readMeta()).fingerprint;
    const source = originalMigrations?.find(
      (migration) => migration.version === target,
    )?.fromSchema;
    if (!source?.postgres) {
      throw new Error("The Doctor fixture requires the exact preceding state schema");
    }
    predecessor = {
      ...stateEngineSchema,
      ...source,
      version: target - 1,
    };
    backup = await statePortProvider.loadDescriptor(undefined, target - 1);

    // The reference anchor must stay outside the update backup's state inventory.
    const referenceRoot = dirs.make("doctor-pg-agent-reference-");
    const targetNamespace = withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(path.join(referenceRoot, "agent.sqlite"));
      const engine = openEngineStore({
        anchor,
        schema: agentEngineSchema,
        input: { connection: connection!, schemaPrefix: "doctor_fixture" },
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
        prepareAnchor() {},
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
      });
      try {
        return getPostgresPhysicalFacts(engine)!.namespace;
      } finally {
        engine.close();
      }
    });
    namespaces.add(targetNamespace);
    targetAgentCatalog = await readAgentCatalog(targetNamespace);
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    stateEngineSchema.postgresMigrations = originalMigrations;
    resetDatabaseEngineSelectionForTest();
    vi.restoreAllMocks();
    for (const owned of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
    }
    await client.end();
  });

  async function prepareSource(schema: StoreSchema) {
    closeOpenClawStateDatabaseForTest();
    // Historical versions own different credentials, publication columns, and indexes.
    // Build their registered DDL instead of relabeling the current predecessor.
    await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    using anchor = openNodeSqliteDatabase(pathname);
    publishSqliteDatabaseSchemaChange(anchor);
    admit(schema, pathname, false);
    await client.query(`
      INSERT INTO "${namespace}".schema_meta
        (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
        VALUES ('primary', 'global', ${schema.version}, NULL, NULL, 1, 1);
      INSERT INTO "${namespace}".config_machine_state VALUES
        ('state.schema.contentVersion', '${schema.version}', 1),
        ('doctor.fixture', '"before"', 1);
    `);
  }

  async function prepare(fail = false) {
    await prepareSource(predecessor);
    stateEngineSchema.postgresMigrations = [
      {
        version: target,
        fromSchema: {
          postgres: predecessor.postgres!,
          postgresFragments: predecessor.postgresFragments,
        },
        schema: {
          postgres: stateEngineSchema.postgres!,
          postgresFragments: stateEngineSchema.postgresFragments,
        },
        backup,
        sql: `UPDATE config_machine_state SET value_json = '"after"' WHERE state_key = 'doctor.fixture'; ${fail ? "SELECT doctor_fixture_midway_failure;" : ""} UPDATE schema_meta SET schema_version = ${target}; UPDATE config_machine_state SET value_json = '${target}' WHERE state_key = 'state.schema.contentVersion';`,
      },
    ];
  }

  async function runDoctor(foundVersion = target - 1) {
    const lock = await acquireGatewayLock({
      env,
      allowInTests: true,
      role: "sqlite-maintenance",
      timeoutMs: 0,
    });
    expect(lock).not.toBeNull();
    try {
      return await lock!.run(async () => {
        const preflight = await preflightOpenClawDatabaseSchemas({ env, scope: "state" });
        expect(preflight.incompatible).toEqual([]);
        expect(preflight.indeterminate).toEqual([]);
        expect(preflight.pendingMigrations).toEqual([
          { kind: "state", path: pathname, foundVersion, supportedVersion: target },
        ]);
        return prepareDoctorDatabaseMigrations({
          env,
          pendingDatabasePaths: [pathname],
          databasePaths: [pathname],
          pendingMigrations: preflight.pendingMigrations,
        });
      });
    } finally {
      await lock!.release();
    }
  }

  it.each([24, 25, 26, 27, 28])(
    "backs up and restores the real version %s before the registered migration",
    async (sourceVersion) => {
      stateEngineSchema.postgresMigrations = originalMigrations;
      const sourceSchema = {
        ...stateEngineSchema,
        ...originalMigrations!.find((migration) => migration.version === sourceVersion + 1)!
          .fromSchema,
        version: sourceVersion,
      };
      await prepareSource(sourceSchema);
      await client.query(`
        INSERT INTO "${namespace}".session_state_heads
          (session_key, agent_id, last_sequence, pruned_max_sequence, updated_at)
          VALUES ('doctor.fixture', 'main', 81, 7, 1);`);
      expect(admit(sourceSchema)?.version).toBe(sourceVersion);
      const before = new Set(archives());
      const result = await runDoctor(sourceVersion);
      expect(result.warnings).toEqual([]);
      expect(await readRows()).toEqual([{ value_json: '"before"' }]);
      expect(await readMeta()).toEqual({ version: String(target), fingerprint: targetFingerprint });
      const directory = path.join(
        path.dirname(pathname),
        archives().find((entry) => !before.has(entry))!,
      );
      const manifest = await verifyMatchedPostgresBackup(directory, "exact");
      expect(manifest.source).toMatchObject({ owner: "state", schemaVersion: sourceVersion });
      {
        using image = openNodeSqliteDatabase(path.join(directory, "database.sqlite"));
        expect(image.prepare("PRAGMA user_version").get()?.user_version).toBe(sourceVersion);
        expect(
          image.prepare("SELECT wr FROM pragma_table_list WHERE name = 'session_state_heads'").get()
            ?.wr,
        ).toBe(sourceVersion >= 26 ? 1 : 0);
        expect(
          image.prepare("SELECT last_sequence, pruned_max_sequence FROM session_state_heads").all(),
        ).toEqual([{ last_sequence: 81, pruned_max_sequence: 7 }]);
      }
      const restoredPath = path.join(env.OPENCLAW_STATE_DIR!, `restored-v${sourceVersion}.sqlite`);
      const restored = await preparePostgresRestore({
        directory,
        anchorPath: restoredPath,
        config,
        profile: "exact",
        assertCurrent() {},
      });
      namespaces.add(restored.namespace);
      expect(admit(sourceSchema, restoredPath)?.version).toBe(sourceVersion);
      expect(
        (
          await client.query(
            `SELECT last_sequence, pruned_max_sequence FROM "${restored.namespace}".session_state_heads`,
          )
        ).rows,
      ).toEqual([{ last_sequence: "81", pruned_max_sequence: "7" }]);
      expect(
        (await client.query(`SELECT schema_version FROM "${restored.namespace}".schema_meta`)).rows,
      ).toEqual([{ schema_version: String(sourceVersion) }]);
    },
  );

  it("captures the predecessor before migration, re-admits exact DDL, and publishes", async () => {
    await prepare();
    const original = await readMeta();
    expect(admit(predecessor)?.version).toBe(target - 1);
    const anchorBytes = fs.readFileSync(pathname);
    const before = new Set(archives());
    const result = await runDoctor();
    expect(result.warnings).toEqual([]);
    expect(await readRows()).toEqual([{ value_json: '"after"' }]);
    expect(await readMeta()).toEqual({ version: String(target), fingerprint: targetFingerprint });
    expect(admit(stateEngineSchema)?.version).toBe(target);
    const directory = path.join(
      path.dirname(pathname),
      archives().find((entry) => !before.has(entry))!,
    );
    const manifest = await verifyMatchedPostgresBackup(directory, "exact");
    expect(manifest.source).toMatchObject({ owner: "state", schemaVersion: target - 1, namespace });
    using image = openNodeSqliteDatabase(path.join(directory, "database.sqlite"));
    expect(
      image
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'doctor.fixture'")
        .get(),
    ).toEqual({ value_json: '"before"' });
    expect(image.prepare("PRAGMA user_version").get()?.user_version).toBe(target - 1);
    expect(original.version).toBe(String(target - 1));
    expect(fs.readFileSync(pathname)).toEqual(anchorBytes);
  });

  it("rolls back partial DDL and data, retaining an exact restorable predecessor", async () => {
    await prepare(true);
    const original = await readMeta();
    const before = new Set(archives());
    await expect(runDoctor()).rejects.toThrow("doctor_fixture_midway_failure");
    expect(await readRows()).toEqual([{ value_json: '"before"' }]);
    expect(await readMeta()).toEqual(original);
    expect(admit(predecessor)?.version).toBe(target - 1);
    const directory = path.join(
      path.dirname(pathname),
      archives().find((entry) => !before.has(entry))!,
    );
    await verifyMatchedPostgresBackup(directory, "exact");
    const restored = await preparePostgresRestore({
      directory,
      anchorPath: path.join(env.OPENCLAW_STATE_DIR!, "restored.sqlite"),
      config,
      profile: "exact",
      assertCurrent() {},
    });
    namespaces.add(restored.namespace);
    expect(admit(predecessor, path.join(env.OPENCLAW_STATE_DIR!, "restored.sqlite"))?.version).toBe(
      target - 1,
    );
    expect(
      (
        await client.query(
          `SELECT value_json FROM "${restored.namespace}".config_machine_state WHERE state_key = 'doctor.fixture'`,
        )
      ).rows,
    ).toEqual([{ value_json: '"before"' }]);
  });

  it("refuses live Gateway custody before creating a backup or running a migration", async () => {
    await prepare();
    // Use the Gateway's physical owner primitive without booting a newer
    // runtime, which would itself run the registered forward migration.
    const gateway = acquireGatewayStateOwner({
      databasePath: pathname,
      payload: { ...defaultPayload(pathname), role: "gateway", port: 19483 },
    });
    expect(await readMeta()).toMatchObject({ version: String(target - 1) });
    expect(await readRows()).toEqual([{ value_json: '"before"' }]);
    try {
      const original = await readMeta();
      const originalRows = await readRows();
      const before = archives();
      await expect(runDoctor()).rejects.toThrow(/Gateway|owner|lock/i);
      expect(archives()).toEqual(before);
      expect(await readMeta()).toEqual(original);
      expect(await readRows()).toEqual(originalRows);
    } finally {
      gateway.release();
    }
  });
  it.each([false, true])(
    "keeps installed-driver schema rollback exact (foreign write: %s)",
    async (foreignWrite) => {
      await prepare();
      await runDoctor();
      closeOpenClawStateDatabaseForTest();
      const configPath = path.join(env.OPENCLAW_STATE_DIR!, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify(config));
      const updateEnv: NodeJS.ProcessEnv = { ...env, OPENCLAW_CONFIG_PATH: configPath };
      vi.stubEnv("OPENCLAW_STATE_DIR", updateEnv.OPENCLAW_STATE_DIR);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const anchorBytes = fs.readFileSync(pathname);
      const run = createUpdateRun({ trigger: "cli", origin: {} }, { env: updateEnv });
      expect(run.phase).toBe("requested");
      recordUpdateRunPhase(run.runId, "validating", {}, { env: updateEnv });
      expect(fs.readFileSync(pathname)).toEqual(anchorBytes);
      closeOpenClawStateDatabaseForTest();
      await client.query(
        `UPDATE "${namespace}".config_machine_state SET value_json = '"before"' WHERE state_key = 'doctor.fixture';
         SELECT setval('"${namespace}".audit_events_sequence_seq', 71, true);`,
      );
      const installed = { ...stateEngineSchema };
      const descriptor = await statePortProvider.loadDescriptor();
      const lock = await acquireGatewayLock({
        env: updateEnv,
        allowInTests: true,
        role: "sqlite-maintenance",
        timeoutMs: 0,
      });
      expect(lock).not.toBeNull();
      let saved: Awaited<ReturnType<typeof createUpdateDatabaseBackup>>;
      const warnings: string[] = [];
      try {
        try {
          saved = await lock!.run(() =>
            createUpdateDatabaseBackupWithFixtureTransport({
              backupRoot: path.join(env.OPENCLAW_STATE_DIR!, `update-capture-${foreignWrite}`),
              stateDir: env.OPENCLAW_STATE_DIR!,
              config,
              env: updateEnv,
              acquisition: { mode: "maintenance-owner" },
            }),
          );
          expect(saved.warnings).toEqual([]);
          const capture = createUpdateDoctorDatabaseWriteCapture(saved.sourceGenerations, {
            env: updateEnv,
            signal: new AbortController().signal,
            assertCurrent: () => lock!.assertCurrent(),
            warn: (message) => warnings.push(message),
          })!;
          await lock!.run(() => capture.admit());
          const futureIndex =
            'CREATE INDEX "idx_doctor_future" ON config_machine_state(updated_at_ms);';
          const futureSchema = `${installed.postgres}\n${futureIndex}`;
          Object.assign(stateEngineSchema, {
            version: target + 1,
            postgres: futureSchema,
            postgresMigrations: [
              {
                version: target + 1,
                fromSchema: {
                  postgres: installed.postgres!,
                  postgresFragments: installed.postgresFragments,
                },
                schema: { postgres: futureSchema, postgresFragments: installed.postgresFragments },
                backup: descriptor,
                sql: `${futureIndex}
                UPDATE config_machine_state SET value_json = '"after"' WHERE state_key = 'doctor.fixture';
                SELECT nextval('audit_events_sequence_seq');
                UPDATE schema_meta SET schema_version = ${target + 1};
                UPDATE config_machine_state SET value_json = '${target + 1}' WHERE state_key = 'state.schema.contentVersion';`,
              },
            ],
          });
          await lock!.run(() =>
            capture.run(() =>
              prepareDoctorDatabaseMigrations({
                env: updateEnv,
                pendingDatabasePaths: [pathname],
                databasePaths: [pathname],
                pendingMigrations: [
                  {
                    kind: "state",
                    path: pathname,
                    foundVersion: target,
                    supportedVersion: target + 1,
                  },
                ],
              }),
            ),
          );
          closeOpenClawStateDatabaseForTest();
          expect(await readRows()).toEqual([{ value_json: '"after"' }]);
          expect(await readMeta()).toMatchObject({ version: String(target + 1) });
          expect(
            (
              await client.query(
                `SELECT last_value, is_called FROM "${namespace}".audit_events_sequence_seq`,
              )
            ).rows,
          ).toEqual([{ last_value: "72", is_called: true }]);
          if (foreignWrite) {
            await client.query(
              `UPDATE "${namespace}".config_machine_state SET value_json = '"foreign"' WHERE state_key = 'doctor.fixture'`,
            );
          }
          // The installed driver's descriptor has no knowledge of the candidate's schema.
          Object.assign(stateEngineSchema, installed);
          await lock!.run(() => capture.settle());
          expect(warnings).toEqual([]);
          expect(capture.receipt?.unchanged).toBe(!foreignWrite);
          const step = {
            name: "candidate Doctor",
            command: "doctor --fix",
            cwd: env.OPENCLAW_STATE_DIR!,
            durationMs: 0,
            exitCode: 0,
          };
          recordUpdateDatabaseWrites(saved, capture.receipt, step);
          expect(saved.restoreRefusal !== undefined).toBe(foreignWrite);
          if (!foreignWrite) {
            expect(saved.migration?.to).toEqual(capture.receipt?.generations);
          }
        } finally {
          Object.assign(stateEngineSchema, installed);
          closeOpenClawStateDatabaseForTest();
          await lock!.release();
        }
        const result = await restoreUpdateDatabaseBackup({
          backup: saved!,
          runId: run.runId,
          env: updateEnv,
          assertCurrent() {},
          expectedGenerations: saved!.migration?.to ?? saved!.sourceGenerations,
        });
        if (foreignWrite) {
          expect(result).toBeNull();
          expect(await readRows()).toEqual([{ value_json: '"foreign"' }]);
          return;
        }
        expect(result).not.toBeNull();
        const restored = readBackupEngine(pathname);
        expect(restored.engine).toBe("postgres");
        if (restored.engine !== "postgres") {
          throw new Error("Rollback did not retain its PostgreSQL anchor");
        }
        namespaces.add(restored.namespace);
        namespace = restored.namespace;
        expect(await readRows()).toEqual([{ value_json: '"before"' }]);
        expect(await readMeta()).toMatchObject({ version: String(target) });
        // Relocation reseals the catalog for its new namespace under the installed schema.
        expect(admit(installed)?.version).toBe(target);
        expect(
          (
            await client.query(
              `SELECT last_value, is_called FROM "${namespace}".audit_events_sequence_seq`,
            )
          ).rows,
        ).toEqual([{ last_value: "71", is_called: true }]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  // Green CI runs 39068774273/39071119824 measured p95 at 104s before fixture reuse.
  it.each([
    [27, false],
    [27, true],
    [30, false],
    [31, false],
    [32, false],
  ] as const)(
    "keeps the real agent v%s→current rollback exact (foreign write: %s)",
    async (sourceVersion, foreignWrite) => {
      // The preceding foreign-write case deliberately retains the candidate state schema.
      closeOpenClawStateDatabaseForTest();
      // Each case backs up only its own synthetic agent, never previous case registrations.
      await client.query(`DELETE FROM "${namespace}".agent_databases WHERE agent_id = 'main'`);
      await client.query(`DROP INDEX IF EXISTS "${namespace}".idx_doctor_future`);
      await prepare();
      await runDoctor();
      closeOpenClawStateDatabaseForTest();
      const configPath = path.join(env.OPENCLAW_STATE_DIR!, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify(config));
      const updateEnv: NodeJS.ProcessEnv = { ...env, OPENCLAW_CONFIG_PATH: configPath };
      vi.stubEnv("OPENCLAW_STATE_DIR", updateEnv.OPENCLAW_STATE_DIR);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const agentPath = path.join(
        env.OPENCLAW_STATE_DIR!,
        `agent-${sourceVersion}-${foreignWrite}`,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(agentPath), { recursive: true });
      const candidate = { ...agentEngineSchema };
      const migration = candidate.postgresMigrations!.find(
        (step) => step.version === sourceVersion + 1,
      )!;
      const installed: StoreSchema = {
        ...candidate,
        version: sourceVersion,
        ...migration.fromSchema,
        postgresVectorDecoderVersion: migration.fromSchema.postgresVectorDecoderVersion,
        postgresVectorSearchVersion: migration.fromSchema.postgresVectorSearchVersion,
        postgresMigrations: [],
      };
      // Build the actual historical layout; dropping current columns would leave
      // PostgreSQL attribute-number holes and change the later migration catalog.
      let agentNamespace = withEngineStoreAdmission(() => {
        using anchor = openNodeSqliteDatabase(agentPath);
        const engine = openEngineStore({
          anchor,
          schema: installed,
          input: { connection: connection!, schemaPrefix: "doctor_fixture" },
          inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
          prepareAnchor() {},
          openSqlite() {
            throw new Error("Expected PostgreSQL");
          },
        });
        try {
          return getPostgresPhysicalFacts(engine)!.namespace;
        } finally {
          engine.close();
        }
      });
      namespaces.add(agentNamespace);
      await client.query(`
        INSERT INTO "${agentNamespace}".schema_meta
          VALUES ('primary', 'agent', ${sourceVersion}, 'main', NULL, 1, 1);
        INSERT INTO "${agentNamespace}".session_key_contract (id, main_key, updated_at)
          VALUES (1, 'main', 0);
        INSERT INTO "${agentNamespace}".memory_index_state VALUES (1, 0);
        INSERT INTO "${agentNamespace}".session_nodes
          (session_key, current_session_id, entry_json, updated_at)
          VALUES ('agent:main:main', 'session', '{"sessionId":"session"}', 1);
        INSERT INTO "${agentNamespace}".session_windows
          (session_id, session_key, created_at, updated_at, transcript_updated_at)
          VALUES ('session', 'agent:main:main', 1, 1, 1);
        INSERT INTO "${agentNamespace}".context_engine_turn_outbox
          (enqueue_sequence, advancement_key, engine_id, session_id, payload_json, created_at)
          VALUES (9, 'retained', 'engine', 'session', '{}', 1);
        INSERT INTO "${agentNamespace}".cache_entries
          (scope, key, value_json, updated_at) VALUES ('fixture', 'migration', '"before"', 1);
        INSERT INTO "${agentNamespace}".memory_entry_origins
          VALUES ('retained-memory', 'main', 'session', 'agent:main:main', 'owner', 1);
        SELECT setval('"${agentNamespace}".context_engine_turn_outbox_enqueue_sequence_seq', 71, true);
      `);
      {
        using anchor = openNodeSqliteDatabase(agentPath);
        publishSqliteDatabaseSchemaChange(anchor);
      }
      expect(admit(installed, agentPath)?.version).toBe(sourceVersion);
      const { runId } = createUpdateRun({ trigger: "cli", origin: {} }, { env: updateEnv });
      withEngineStoreAdmission(() => {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(`INSERT INTO agent_databases
            (agent_id, path, schema_version, last_seen_at) VALUES ('main', ?, ?, 1)`).run(
              agentPath,
              installed.version,
            );
          },
          { env: updateEnv },
        );
      });
      closeOpenClawStateDatabaseForTest();
      const readAgent = async () =>
        (
          await client.query(`SELECT value_json FROM "${agentNamespace}".cache_entries
          WHERE scope = 'fixture' AND key = 'migration'`)
        ).rows;
      const readAllocation = async () =>
        (
          await client.query(`SELECT last_value, is_called
          FROM "${agentNamespace}".context_engine_turn_outbox_enqueue_sequence_seq`)
        ).rows;
      const readNavigationFunction = async () =>
        (
          await client.query(
            `SELECT p.proisstrict, p.proconfig FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1 AND p.proname = 'openclaw_transcript_navigation_check'`,
            [agentNamespace],
          )
        ).rows;
      const readIndexes = async () =>
        (
          await client.query<{ indexname: string; indexdef: string }>(
            `SELECT indexname, indexdef
          FROM pg_indexes WHERE schemaname = $1 AND indexname IN
          ('idx_agent_transcript_event_parent', 'idx_agent_session_windows_conversation',
           'idx_agent_session_nodes_last_interaction_at', 'idx_agent_session_reactions_message')
          ORDER BY indexname`,
            [agentNamespace],
          )
        ).rows.map(({ indexname, indexdef }) => ({
          indexname,
          indexdef: indexdef.replaceAll(agentNamespace, "fixture_namespace"),
        }));
      const beforeIndexes = await readIndexes();
      expect(beforeIndexes).toEqual(
        sourceVersion === 27
          ? [
              {
                indexname: "idx_agent_session_nodes_last_interaction_at",
                indexdef:
                  "CREATE INDEX idx_agent_session_nodes_last_interaction_at ON fixture_namespace.session_nodes USING btree (last_interaction_at DESC NULLS LAST, session_key NULLS FIRST)",
              },
              {
                indexname: "idx_agent_session_reactions_message",
                indexdef:
                  "CREATE INDEX idx_agent_session_reactions_message ON fixture_namespace.session_reactions USING btree (session_key NULLS FIRST, session_id NULLS FIRST, message_id NULLS FIRST)",
              },
              {
                indexname: "idx_agent_session_windows_conversation",
                indexdef:
                  "CREATE INDEX idx_agent_session_windows_conversation ON fixture_namespace.session_windows USING btree (primary_conversation_id NULLS FIRST, updated_at DESC NULLS LAST, session_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)",
              },
              {
                indexname: "idx_agent_transcript_event_parent",
                indexdef:
                  "CREATE INDEX idx_agent_transcript_event_parent ON fixture_namespace.transcript_event_identities USING btree (session_id NULLS FIRST, parent_id NULLS FIRST) WHERE (parent_id IS NOT NULL)",
              },
            ]
          : [
              {
                indexname: "idx_agent_session_windows_conversation",
                indexdef:
                  "CREATE INDEX idx_agent_session_windows_conversation ON fixture_namespace.session_windows USING btree (primary_conversation_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)",
              },
            ],
      );
      const beforeNavigation = await readNavigationFunction();
      if (sourceVersion === 32) {
        expect(() =>
          withOpenClawAgentDatabaseReadOnly(() => {}, {
            agentId: "main",
            path: agentPath,
            env: updateEnv,
          }),
        ).toThrow(/stopped-writer maintenance/);
        const inspected: string[] = [];
        await expect(
          repairLegacySessionEntryStates({
            apply: true,
            cfg: config,
            env: updateEnv,
            deferSchemaRepair: true,
            targets: [{ agentId: "main", storePath: agentPath, sqlitePath: agentPath }],
            onInspectedTargets: (targets) => {
              inspected.push(...targets.map((item) => item.sqlitePath));
            },
          }),
        ).resolves.toEqual({ found: 0, repaired: 0, scannedStores: 1 });
        expect(inspected).toEqual([]);
        expect(
          (await client.query(`SELECT version FROM "${agentNamespace}".openclaw_schema_meta`)).rows,
        ).toEqual([{ version: "32" }]);
      }
      const lock = await acquireGatewayLock({
        env: updateEnv,
        allowInTests: true,
        role: "sqlite-maintenance",
        timeoutMs: 0,
      });
      expect(lock).not.toBeNull();
      let saved: Awaited<ReturnType<typeof createUpdateDatabaseBackup>>;
      const warnings: string[] = [];
      try {
        try {
          saved = await lock!.run(() =>
            createUpdateDatabaseBackupWithFixtureTransport({
              backupRoot: path.join(
                env.OPENCLAW_STATE_DIR!,
                `agent-capture-${sourceVersion}-${foreignWrite}`,
              ),
              stateDir: env.OPENCLAW_STATE_DIR!,
              config,
              env: updateEnv,
              acquisition: { mode: "maintenance-owner" },
            }),
          );
          expect(saved.warnings).toEqual([]);
          const agentBackup = saved.databases.find((database) => database.path === agentPath)!;
          expect(agentBackup).toMatchObject({ engine: "postgres", namespace: agentNamespace });
          {
            using image = openNodeSqliteDatabase(
              path.join(agentBackup.exportDirectory!, "database.sqlite"),
            );
            expect(image.prepare("PRAGMA user_version").get()?.user_version).toBe(sourceVersion);
            expect(
              image
                .prepare("SELECT wr FROM pragma_table_list WHERE name = 'memory_entry_origins'")
                .get()?.wr,
            ).toBe(sourceVersion < 28 ? 0 : 1);
            expect(
              image.prepare("SELECT entry_key, origin_class FROM memory_entry_origins").all(),
            ).toEqual([{ entry_key: "retained-memory", origin_class: "owner" }]);
          }
          const capture = createUpdateDoctorDatabaseWriteCapture(saved.sourceGenerations, {
            env: updateEnv,
            signal: new AbortController().signal,
            assertCurrent: () => lock!.assertCurrent(),
            warn: (message) => warnings.push(message),
          })!;
          await lock!.run(() => capture.admit());
          // Keep the registered DDL and predecessor resolution; add observable
          // candidate writes to prove rollback restores retained rows and allocation.
          const migrationWithCandidateWrites = {
            ...migration,
            sql: `${migration.sql}
              UPDATE cache_entries SET value_json = '"after"' WHERE scope = 'fixture';
              SELECT nextval('context_engine_turn_outbox_enqueue_sequence_seq');`,
          };
          agentEngineSchema.postgresMigrations = candidate.postgresMigrations!.map((step) =>
            step === migration ? migrationWithCandidateWrites : step,
          );
          if (!foreignWrite) {
            expect(() =>
              withEngineStoreAdmission(() => {
                using anchor = openNodeSqliteDatabase(agentPath);
                const engine = openAgentEngineStore(anchor, "main", agentPath, true);
                engine.close();
              }),
            ).toThrow(/stopped-writer maintenance/);
            expect(await readAgent()).toEqual([{ value_json: '"before"' }]);
            expect(await readIndexes()).toEqual(beforeIndexes);
          }
          const result = await lock!.run(() =>
            capture.run(() =>
              prepareDoctorDatabaseMigrations({
                env: updateEnv,
                pendingDatabasePaths: [agentPath],
                databasePaths: [pathname, agentPath],
                agentDatabaseTargets: [
                  { agentId: "main", path: agentPath, realPath: agentPath, source: "registry" },
                ],
                pendingMigrations: [
                  {
                    kind: "agent",
                    path: agentPath,
                    foundVersion: installed.version,
                    supportedVersion: candidate.version,
                  },
                ],
              }),
            ),
          );
          expect(result.warnings).toEqual([]);
          closeOpenClawStateDatabaseForTest();
          expect(await readAgent()).toEqual([{ value_json: '"after"' }]);
          expect(admit(candidate, agentPath)?.version).toBe(candidate.version);
          expect(await readAgentCatalog(agentNamespace)).toEqual(targetAgentCatalog);
          expect(await readAllocation()).toEqual([{ last_value: "72", is_called: true }]);
          expect(await readNavigationFunction()).toEqual([
            { proisstrict: true, proconfig: ["search_path=pg_catalog"] },
          ]);
          expect(await readIndexes()).toEqual([
            {
              indexname: "idx_agent_session_windows_conversation",
              indexdef:
                "CREATE INDEX idx_agent_session_windows_conversation ON fixture_namespace.session_windows USING btree (primary_conversation_id NULLS FIRST) WHERE (primary_conversation_id IS NOT NULL)",
            },
          ]);
          if (foreignWrite) {
            await client.query(`UPDATE "${agentNamespace}".cache_entries
              SET value_json = '"foreign"' WHERE scope = 'fixture'`);
          }
          Object.assign(agentEngineSchema, installed);
          await lock!.run(() => capture.settle());
          Object.assign(agentEngineSchema, candidate);
          expect(warnings).toEqual([]);
          expect(capture.receipt?.unchanged).toBe(!foreignWrite);
          recordUpdateDatabaseWrites(saved, capture.receipt, {
            name: "candidate agent Doctor",
          });
          expect(saved.restoreRefusal !== undefined).toBe(foreignWrite);
        } finally {
          Object.assign(agentEngineSchema, candidate);
          closeOpenClawStateDatabaseForTest();
          await lock!.release();
        }
        const restored = await restoreUpdateDatabaseBackup({
          backup: saved!,
          runId,
          env: updateEnv,
          assertCurrent() {},
          expectedGenerations: saved!.migration?.to ?? saved!.sourceGenerations,
        });
        if (foreignWrite) {
          expect(restored).toBeNull();
          expect(await readAgent()).toEqual([{ value_json: '"foreign"' }]);
          expect(await readAllocation()).toEqual([{ last_value: "72", is_called: true }]);
          return;
        }
        expect(restored).not.toBeNull();
        const anchor = readBackupEngine(agentPath);
        if (anchor.engine !== "postgres") {
          throw new Error("Agent rollback did not retain its PostgreSQL anchor");
        }
        agentNamespace = anchor.namespace;
        namespaces.add(agentNamespace);
        const state = readBackupEngine(pathname);
        if (state.engine === "postgres") {
          namespace = state.namespace;
          namespaces.add(namespace);
        }
        expect(await readAgent()).toEqual([{ value_json: '"before"' }]);
        expect(
          (await client.query(`SELECT version FROM "${agentNamespace}".openclaw_schema_meta`)).rows,
        ).toEqual([{ version: String(installed.version) }]);
        expect(await readAllocation()).toEqual([{ last_value: "71", is_called: true }]);
        expect(await readNavigationFunction()).toEqual(beforeNavigation);
        expect(await readIndexes()).toEqual(beforeIndexes);
        expect(
          (
            await client.query(`SELECT enqueue_sequence, advancement_key
          FROM "${agentNamespace}".context_engine_turn_outbox`)
          ).rows,
        ).toEqual([{ enqueue_sequence: "9", advancement_key: "retained" }]);
        expect(
          (
            await client.query(
              `SELECT entry_key, origin_class FROM "${agentNamespace}".memory_entry_origins`,
            )
          ).rows,
        ).toEqual([{ entry_key: "retained-memory", origin_class: "owner" }]);
        expect(admit(installed, agentPath)?.version).toBe(sourceVersion);
        await client.query(`INSERT INTO "${agentNamespace}".memory_index_sources (path, source, hash, mtime, size)
            VALUES ('restored.md', 'memory', 'hash', 1, 1);`);
        expect(
          (await client.query(`SELECT revision FROM "${agentNamespace}".memory_index_state`)).rows,
        ).toEqual([{ revision: sourceVersion < 31 ? "1" : "0" }]);
      } finally {
        Object.assign(agentEngineSchema, candidate);
        vi.unstubAllEnvs();
      }
    },
    220_000,
  );
});
