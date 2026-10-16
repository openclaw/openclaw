import "./backup-worker.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareDoctorDatabaseMigrations } from "../../commands/doctor-schema-migrations.js";
import {
  preparePostgresRestore,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
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
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import type { StoreSchema } from "./contract.js";
import { openEngineStore } from "./open.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import type { PortDescriptor } from "./port-descriptor.js";
import { statePortProvider } from "./state-port.js";

// Keep the actual read contracts in-process so all consumers see the
// synthetic migration registration; retain the real reply decoder.
const reads = vi.hoisted(() => ({
  capture: vi.fn<typeof StateReadWorker.captureOpenClawStateReadSource>(),
  decode: vi.fn<typeof StateReadWorker.decodeOpenClawStateReadReply>(),
  retire: vi.fn<typeof StateReadWorker.retireIdleOpenClawStateReadWorkers>(),
}));
// mock-isolation: Install transport before cyclic state imports; load the real decoder afterward so the synthetic migration stays in-process.
vi.mock("../../state/openclaw-state-read-worker.js", () => ({
  captureOpenClawStateReadSource: reads.capture,
  decodeOpenClawStateReadReply: reads.decode,
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
  let indexSql: string;
  let targetFingerprint: unknown;
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

  function admit(schema: StoreSchema, file = pathname) {
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
        existingOnly: true,
      });
      try {
        return getPostgresPhysicalFacts(db);
      } finally {
        db.close();
      }
    });
  }

  beforeAll(async () => {
    const worker = await vi.importActual<typeof StateReadWorker>(
      "../../state/openclaw-state-read-worker.js",
    );
    reads.decode.mockImplementation(worker.decodeOpenClawStateReadReply);
    reads.retire.mockImplementation(worker.retireIdleOpenClawStateReadWorkers);
    reads.capture.mockImplementation(() => ({
      own: () => () => {},
      service() {},
      createTransport: (command) =>
        createMockStateReadSource({
          read: async (source) => reads.decode(await readInProcess(command, source)),
          async close() {},
        }).createTransport(command),
    }));
    await client.connect();
    env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("doctor-pg-migration-") };
    pathname = resolveOpenClawStateSqlitePath(env);
    installDatabaseEngineSelection({
      input: { connection: connection!, schemaPrefix: "doctor_fixture" },
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
    indexSql = stateEngineSchema.postgres!.match(/CREATE INDEX "idx_state_leases_owner"[^;]+;/)![0];
    predecessor = {
      ...stateEngineSchema,
      version: target - 1,
      postgres: stateEngineSchema.postgres!.replace(indexSql, ""),
    };
    const descriptor = await statePortProvider.loadDescriptor();
    backup = {
      ...descriptor,
      version: target - 1,
      admit: undefined,
      sqlite: descriptor.sqlite.replace(/CREATE INDEX[^;]*idx_state_leases_owner[^;]*;/, ""),
      postData: descriptor.postData.replace(indexSql, ""),
      expectedCatalog: descriptor.expectedCatalog.map((fact) =>
        fact.table === "state_leases" && fact.kind === "indexes"
          ? { table: "state_leases", kind: "indexes", value: 2 }
          : fact,
      ),
    };
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

  async function prepare(fail = false) {
    closeOpenClawStateDatabaseForTest();
    await client.query(`DROP INDEX IF EXISTS "${namespace}".idx_state_leases_owner;
      UPDATE "${namespace}".openclaw_schema_meta SET version = ${target - 1}, fingerprint = NULL, ddl_hash = NULL, server_major = NULL;
      UPDATE "${namespace}".schema_meta SET schema_version = ${target - 1};
      UPDATE "${namespace}".config_machine_state SET value_json = '${target - 1}' WHERE state_key = 'state.schema.contentVersion';
      INSERT INTO "${namespace}".config_machine_state VALUES ('doctor.fixture', '"before"', 1) ON CONFLICT (state_key) DO UPDATE SET value_json = '"before"';`);
    // R2 compares and seals the predecessor against its complete DDL.
    using anchor = openNodeSqliteDatabase(pathname);
    publishSqliteDatabaseSchemaChange(anchor);
    admit(predecessor);
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
        sql: `${indexSql} UPDATE config_machine_state SET value_json = '"after"' WHERE state_key = 'doctor.fixture'; ${fail ? "SELECT doctor_fixture_midway_failure;" : ""} UPDATE schema_meta SET schema_version = ${target}; UPDATE config_machine_state SET value_json = '${target}' WHERE state_key = 'state.schema.contentVersion';`,
      },
    ];
  }

  async function runDoctor() {
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
          { kind: "state", path: pathname, foundVersion: target - 1, supportedVersion: target },
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

  it("captures the predecessor before migration, re-admits exact DDL, and publishes", async () => {
    await prepare();
    const original = await readMeta();
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
    expect(original.fingerprint).not.toBe(targetFingerprint);
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
});
