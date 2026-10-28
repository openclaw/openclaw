import "../test-utils/prepare-compiled-subprocesses.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { inflateSync } from "node:zlib";
import { Client } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/sqlite-json.js";
import { doctorOutputEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import {
  captureUpdateDatabases,
  restoreFailedUpdateDatabases,
} from "../cli/update-cli/update-command-database-backup.js";
import { recordUpdateDatabaseWrites } from "../cli/update-cli/update-command-database-receipts.js";
import type { MutableUpdateExecutionParams } from "../cli/update-cli/update-command-execution.types.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { backupDoctorMigrationDatabases } from "../commands/doctor-migration-backup.js";
import { prepareDoctorDatabaseMigrations } from "../commands/doctor-schema-migrations.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { readBackupEngine, verifyMatchedPostgresBackup } from "../snapshot/database-backup.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import { withLegacyStateHeadLayout } from "../state/openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "../state/openclaw-state-db-schema-v27-indexes.js";
import { withLegacyPublicationDraft } from "../state/openclaw-state-db-schema-v28-publication.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { readClientCredentialReceipt } from "./client-credential-readiness.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "./client-credential-store.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { openEngineStore } from "./database-engine/open.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";
import { inspectScopedMigrationSnapshot } from "./sqlite-migration-scoped-snapshot.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);
const namespaces = new Set<string>();
const identity = generateStoredDeviceIdentity(12);
const stat4Enabled = (() => {
  using database = openNodeSqliteDatabase(":memory:");
  return Boolean(
    database.prepare("SELECT sqlite_compileoption_used('ENABLE_STAT4') AS enabled").get()!.enabled,
  );
})();
const credentialTables = [
  "device_identities",
  "device_auth_tokens",
  "gateway_origin_device_tokens",
] as const;
const policy = {
  version: 1,
  socket: { path: "/synthetic/native.sock", token: "synthetic-socket-token", future: "keep" },
  defaults: { security: "allowlist", ask: "on-miss" },
  agents: {},
};

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetDatabaseEngineSelectionForTest();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (!connection || namespaces.size === 0) {
    return;
  }
  const client = new Client({ connectionString: connection });
  await client.connect();
  try {
    for (const namespace of namespaces) {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
  } finally {
    await client.end();
  }
});

function seedCredentials(db: EngineConnection, native: boolean, sourceVersion: 25 | 26 | 27 | 28) {
  db.prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)").run(
    "primary",
    identity.deviceId,
    identity.publicKeyPem,
    identity.privateKeyPem,
    12,
    99,
  );
  db.prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)").run(
    identity.deviceId,
    "operator",
    "synthetic-original-token",
    '[ "operator.read" ]',
    101,
  );
  if (native) {
    return;
  }
  db.prepare("INSERT INTO gateway_origin_device_tokens VALUES (?, ?, ?, ?, ?, ?)").run(
    "https://synthetic.invalid",
    identity.deviceId,
    "operator",
    "synthetic-origin-token",
    '["operator.write"]',
    102,
  );
  db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "current",
    JSON.stringify(policy),
    policy.socket.path,
    1,
    "allowlist",
    "on-miss",
    null,
    null,
    0,
    0,
    104,
  );
  db.prepare(
    "INSERT INTO schema_meta VALUES ('primary', 'global', ?, NULL, 'fixture', 123, 123)",
  ).run(sourceVersion);
  db.prepare("INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', ?, 1)").run(
    String(sourceVersion),
  );
}

async function fixture(
  engine: "sqlite" | "postgres",
  native = false,
  sourceVersion: 25 | 26 | 27 | 28 = 25,
  initialState: "seeded" | "legacy-statistics" | "empty" = "seeded",
) {
  const root = fs.realpathSync(directories.make("client-update-"));
  const stateDir = path.join(root, "state-root");
  const pathname = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  if (initialState === "legacy-statistics") {
    // Empty SQLite database produced by ANALYZE sqlite_schema with ENABLE_STAT4.
    fs.writeFileSync(
      pathname,
      inflateSync(
        Buffer.from(
          "eNoLDvTJLElVSMsvyk0sUTBmYGJgZGRwUFBgYGBgBGJmBgQA8VnQ+IQAI4PezA28QAYTYzgD42YgMTJAFBObuKoqY2VJYlJOanFhDjCM44tLEktMkNnMzkGujiGuCiGOTj6uCsgyGiVJOTqZKRU6eamFOnk5JTp5KUCiODG3ICdV05sRbHY0utmGyGwmXGYbws0G8TRBcQOM9FEwQsFo/I9sAADhwUKC",
          "base64",
        ),
      ),
    );
  }
  const config =
    engine === "postgres"
      ? { database: { engine: "postgres", postgres: { connection: connection! } } }
      : {};
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("OPENCLAW_") || key === "HOME" || key === "USERPROFILE") {
      vi.stubEnv(key, value);
    }
  }
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  if (engine === "postgres") {
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: "client_update" },
    });
  } else {
    resetDatabaseEngineSelectionForTest();
  }
  if (engine === "postgres" && !native) {
    withEngineStoreAdmission(() => {
      using anchor = openNodeSqliteDatabase(pathname);
      const source = openEngineStore({
        anchor,
        schema: {
          id: "state",
          version: sourceVersion,
          sqlite: "",
          ...stateEngineSchema.postgresMigrations!.find(
            (step) => step.version === sourceVersion + 1,
          )!.fromSchema,
        },
        input: { connection: connection!, schemaPrefix: "client_update" },
        inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
        prepareAnchor() {},
        openSqlite() {
          throw new Error("Expected PostgreSQL predecessor");
        },
      });
      try {
        if (!isPostgresSqlConnection(source)) {
          throw new Error("Expected PostgreSQL predecessor");
        }
        namespaces.add(getPostgresPhysicalFacts(source)!.namespace);
        source.runTransaction(() => seedCredentials(source, false, sourceVersion));
      } finally {
        source.close();
      }
    });
  } else if (initialState !== "empty") {
    using db = openNodeSqliteDatabase(pathname);
    if (native) {
      db.exec(
        CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
          0,
          CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE gateway_origin_device_tokens"),
        ),
      );
    } else {
      const publicationSchema =
        sourceVersion < 28
          ? withLegacyPublicationDraft(OPENCLAW_STATE_SCHEMA_SQL)
          : OPENCLAW_STATE_SCHEMA_SQL;
      const indexedSchema =
        sourceVersion < 27 ? withLegacyStateWriteIndexes(publicationSchema) : publicationSchema;
      db.exec(sourceVersion < 26 ? withLegacyStateHeadLayout(indexedSchema) : indexedSchema);
      db.exec(
        CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
          0,
          CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE native_exec_socket_credentials"),
        ),
      );
      db.exec(`PRAGMA user_version=${sourceVersion}`);
    }
    seedCredentials(db, native, sourceVersion);
  }
  const readShared = async () => {
    const anchor = readBackupEngine(pathname);
    if (anchor.engine === "postgres") {
      namespaces.add(anchor.namespace);
      const client = new Client({ connectionString: connection });
      await client.connect();
      try {
        const credentialRows = await client.query(
          `SELECT token FROM "${anchor.namespace}".device_auth_tokens`,
        );
        const meta = await client.query(
          `SELECT schema_version FROM "${anchor.namespace}".schema_meta`,
        );
        const approvals = await client.query(
          `SELECT raw_json FROM "${anchor.namespace}".exec_approvals_config`,
        );
        return {
          version: Number(meta.rows[0].schema_version),
          token: credentialRows.rows[0].token,
          policy: JSON.parse(approvals.rows[0].raw_json),
        };
      } finally {
        await client.end();
      }
    }
    using db = openNodeSqliteDatabase(pathname, { readOnly: true });
    return {
      version: Number(db.prepare("PRAGMA user_version").get()!.user_version),
      token: db.prepare("SELECT token FROM device_auth_tokens").get()!.token,
      policy: native
        ? undefined
        : JSON.parse(
            String(db.prepare("SELECT raw_json FROM exec_approvals_config").get()!.raw_json),
          ),
    };
  };
  return { root, pathname, env, engine, native, sourceVersion, readShared };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function capture(f: Fixture, fresh = false) {
  const run = createUpdateRun({ trigger: "cli" }, { env: f.env });
  expect(run.phase).toBe("requested");
  // An installed driver's ledger admission must not run the candidate migration.
  if (fresh) {
    // Public ledger admission initializes a fresh installation before capture.
    expect(fs.existsSync(f.pathname)).toBe(true);
  } else {
    expect((await f.readShared()).version).toBe(f.native ? 0 : f.sourceVersion);
  }
  expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(fresh);
  await closeOpenClawStateDatabaseAsync();
  const unexpected = () => {
    throw new Error("Database capture attempted unrelated update orchestration");
  };
  const execution: MutableUpdateExecutionParams = {
    root: f.root,
    installKind: "package",
    updateInstallKind: "package",
    switchToGit: false,
    timeoutMs: undefined,
    updateStepTimeoutMs: 30_000,
    startedAt: 1,
    progress: {},
    executionGuards: {
      recordPhase: unexpected,
      recordStep: unexpected,
      captureWriteOptions: unexpected,
      onStateHandoff: unexpected,
      admitExecutor: unexpected,
      assertCurrent() {},
      waitForCurrent: unexpected,
      assertBoundChildCurrent() {},
    },
    stop: unexpected,
    channel: "stable",
    tag: "fixture",
    opts: { run: { runId: run.runId, env: f.env } },
    shouldRestart: false,
    packageInstallSpec: null,
    packageUpdateNodeRunner: process.execPath,
    managedServiceRootRedirect: null,
    recoveryState: { triageTarget: { env: f.env } },
    prepareMutableUpdate: unexpected,
  };
  const result = await captureUpdateDatabases({
    transaction: {
      backupRoot: path.join(f.root, run.runId),
      rollback: unexpected,
      complete: unexpected,
    },
    execution,
    context: undefined,
    assertCurrent() {},
  });
  expect(result.backup, result.step.warnings?.join("\n")).toBeDefined();
  expect(result.backup!.warnings).toEqual([]);
  expect(result.backup!.sourceGenerations[f.pathname]).toEqual(expect.any(String));
  return { run, backup: result.backup! };
}

async function migrate(f: Fixture, captured?: Awaited<ReturnType<typeof capture>>, fresh = false) {
  const maintenance = await beginDoctorMaintenance({
    root: null,
    options: { repair: true, nonInteractive: true },
    runtime: { log() {}, error() {}, exit() {} },
    databaseGenerations: captured?.backup.sourceGenerations,
  });
  expect(maintenance).toBeDefined();
  try {
    const outcome = await maintenance!.run(() =>
      f.native || fresh
        ? prepareOpenClawStateDatabaseSchema({ env: f.env }, "doctor")
        : prepareDoctorDatabaseMigrations({
            env: f.env,
            databasePaths: [f.pathname],
            pendingDatabasePaths: [f.pathname],
            pendingMigrations: [
              {
                kind: "state",
                path: f.pathname,
                foundVersion: f.native ? 0 : f.sourceVersion,
                supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
              },
            ],
          }),
    );
    expect(outcome.warnings).toEqual([]);
    await maintenance!.releaseState();
    if (captured) {
      const writes = maintenance!.databaseWrites;
      expect(
        writes?.unchanged,
        JSON.stringify({
          warnings: maintenance!.warnings,
          source: captured.backup.sourceGenerations,
          writes,
        }),
      ).toBe(true);
      expect(Object.keys(writes!.generations).toSorted()).toEqual(
        Object.keys(captured.backup.sourceGenerations).toSorted(),
      );
      expect(
        recordUpdateDatabaseWrites(captured.backup, writes, {
          name: "candidate Doctor",
        }),
      ).toBeDefined();
      expect(captured.backup.restoreRefusal).toBeUndefined();
    }
  } finally {
    await maintenance!.release();
    await closeOpenClawStateDatabaseAsync();
  }
  if (fresh) {
    using local = openClientCredentialCustody(f.env, { migration: true })!;
    expect(readClientCredentialReceipt(local.database)?.phase).toBe("complete");
  } else {
    assertMigratedCredentials(f);
  }
}

function assertMigratedCredentials(f: Fixture) {
  using local = openClientCredentialCustody(f.env, { migration: true })!;
  expect(readClientCredentialReceipt(local.database)?.phase).toBe("complete");
  expect(local.database.prepare("SELECT * FROM device_identities").get()).toEqual({
    identity_key: "primary",
    device_id: identity.deviceId,
    public_key_pem: identity.publicKeyPem,
    private_key_pem: identity.privateKeyPem,
    created_at_ms: 12,
    updated_at_ms: 99,
  });
  expect(local.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
    token: "synthetic-original-token",
  });
  if (!f.native) {
    expect(
      local.database
        .prepare("SELECT socket_path,socket_token FROM native_exec_socket_credentials")
        .get(),
    ).toEqual({
      socket_path: "/synthetic/native.sock",
      socket_token: "synthetic-socket-token",
    });
  }
}

async function rollback(f: Fixture, captured: Awaited<ReturnType<typeof capture>>, fresh = false) {
  const result: UpdateRunResult = {
    status: "error",
    mode: "npm",
    durationMs: 0,
    reason: "synthetic-candidate-failure",
    steps: [],
  };
  expect(
    await restoreFailedUpdateDatabases({
      backup: captured.backup,
      runId: captured.run.runId,
      env: f.env,
      assertCurrent() {},
      result,
      progress: {},
    }),
    JSON.stringify(result),
  ).toBe(true);
  if (fresh) {
    using shared = openNodeSqliteDatabase(f.pathname, { readOnly: true });
    expect(shared.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  } else {
    expect(await f.readShared()).toEqual({
      version: f.native ? 0 : f.sourceVersion,
      token: "synthetic-original-token",
      policy: f.native ? undefined : policy,
    });
  }
  expect(getUpdateRun(captured.run.runId, { env: f.env })).toEqual(captured.run);
}

describe("client credential public update custody", () => {
  it("preserves a fresh installation through public capture, Doctor, and rollback", async () => {
    const f = await fixture("sqlite", false, 25, "empty");
    const captured = await capture(f, true);
    expect(captured.backup.sourceGenerations[resolveClientCredentialStorePath(f.env)]).toEqual(
      expect.any(String),
    );
    await migrate(f, captured, true);
    expect(
      runClientCredentialOperation(
        f.env,
        { kind: "identity.read", identity_key: "primary" },
        { readOnly: true },
      ),
    ).toEqual({ kind: "identity", identity: null });
    await rollback(f, captured, true);
    expect(
      runClientCredentialOperation(
        f.env,
        { kind: "identity.read", identity_key: "primary" },
        { readOnly: true },
      ),
    ).toEqual({ kind: "identity", identity: null });
  });

  it.each(["metadata", "key material"] as const)(
    "keeps Doctor repair reachable for predecessor identity %s without reimporting retained JSON",
    async (damage) => {
      const f = await fixture("sqlite", false, 26);
      const retainedIdentity = generateStoredDeviceIdentity(19);
      const legacyPath = path.join(f.env.OPENCLAW_STATE_DIR, "identity", "device.json");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      const legacyBytes = Buffer.from(`${JSON.stringify({ version: 1, ...retainedIdentity })}\n`);
      fs.writeFileSync(legacyPath, legacyBytes);
      const sourceIdentity = (() => {
        using source = openNodeSqliteDatabase(f.pathname);
        // This predecessor already completed the independent shared-auth relocation.
        source
          .prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)")
          .run(SHARED_AUTH_STORE_STATE_KEY, JSON.stringify({ location: "state-db" }), 1);
        if (damage === "metadata") {
          source
            .prepare("UPDATE device_identities SET device_id=?,created_at_ms=-1,updated_at_ms=-1")
            .run("0".repeat(64));
        } else {
          source
            .prepare("UPDATE device_identities SET private_key_pem=?")
            .run(retainedIdentity.privateKeyPem);
        }
        return source.prepare("SELECT * FROM device_identities").get();
      })();
      const captured = await capture(f);
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
        databaseGenerations: captured.backup.sourceGenerations,
      });
      expect(maintenance).toBeDefined();
      try {
        const result = await maintenance!.run(() =>
          autoMigrateLegacyState({
            cfg: {},
            env: f.env,
            homedir: () => f.root,
            doctorOnlyStateMigrations: true,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          }),
        );
        expect(
          result.warnings,
          JSON.stringify({
            changes: result.changes,
            stepReceipts: result.stepReceipts,
            maintenanceWarnings: maintenance!.warnings,
          }),
        ).toEqual([]);
        expect(result.stepReceipts?.find((receipt) => receipt.id === "state-schema")).toMatchObject(
          {
            outcome: "completed",
          },
        );
        expect(
          result.stepReceipts?.find((receipt) => receipt.id === "device-identity"),
        ).toMatchObject({ outcome: "completed" });
        const repaired = runClientCredentialOperation(
          f.env,
          { kind: "identity.read", identity_key: "primary" },
          { readOnly: true },
        );
        if (repaired.kind !== "identity" || !repaired.identity) {
          throw new Error("Doctor did not leave a readable primary identity.");
        }
        if (damage === "metadata") {
          expect(result.changes).toContain(
            "Repaired invalid primary device identity metadata in SQLite.",
          );
          expect(repaired.identity).toMatchObject({
            device_id: identity.deviceId,
            public_key_pem: identity.publicKeyPem,
            private_key_pem: identity.privateKeyPem,
          });
          expect(result.notices ?? []).not.toContain(
            "The repaired device has a new identity and must be approved again.",
          );
        } else {
          expect(result.changes).toContain("Replaced invalid primary device identity in SQLite.");
          expect(result.notices).toContain(
            "The repaired device has a new identity and must be approved again.",
          );
          expect(repaired.identity.device_id).not.toBe(identity.deviceId);
        }
        expect(repaired.identity.device_id).not.toBe(retainedIdentity.deviceId);
        expect(fs.readFileSync(legacyPath)).toEqual(legacyBytes);
        {
          using local = openClientCredentialCustody(f.env, { migration: true })!;
          expect(readClientCredentialReceipt(local.database)).toMatchObject({
            phase: "complete",
            receipt: { legacyImports: { "identity:primary": { sha256: null } } },
          });
          expect(local.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
            token: "synthetic-original-token",
          });
        }
        await maintenance!.releaseState();
        const writes = maintenance!.databaseWrites;
        expect(
          writes?.unchanged,
          JSON.stringify({
            warnings: maintenance!.warnings,
            source: captured.backup.sourceGenerations,
            writes,
          }),
        ).toBe(true);
        expect(
          recordUpdateDatabaseWrites(captured.backup, writes, {
            name: "candidate Doctor",
          }),
        ).toBeDefined();
        expect(captured.backup.restoreRefusal).toBeUndefined();
      } finally {
        await maintenance!.release();
        await closeOpenClawStateDatabaseAsync();
      }
      await rollback(f, captured);
      {
        using restored = openNodeSqliteDatabase(f.pathname, { readOnly: true });
        expect(restored.prepare("SELECT * FROM device_identities").get()).toEqual(sourceIdentity);
      }
      expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
      expect(fs.readFileSync(legacyPath)).toEqual(legacyBytes);
    },
  );

  it("migrates SQLite despite stale socket projections, restores exact credentials, and rebuilds an orphan through Doctor", async () => {
    const f = await fixture("sqlite");
    const originalApprovals = (() => {
      using source = openNodeSqliteDatabase(f.pathname);
      source
        .prepare("UPDATE exec_approvals_config SET socket_path=?,has_socket_token=0")
        .run("/synthetic/stale.sock");
      return source.prepare("SELECT * FROM exec_approvals_config").get();
    })();
    const captured = await capture(f);
    await migrate(f, captured);
    {
      using shared = openNodeSqliteDatabase(f.pathname, { readOnly: true });
      const findTable = shared.prepare("SELECT name FROM sqlite_schema WHERE name=?");
      for (const table of credentialTables) {
        expect(findTable.get(table)).toBeUndefined();
      }
      expect(
        JSON.parse(
          String(shared.prepare("SELECT raw_json FROM exec_approvals_config").get()!.raw_json),
        ),
      ).toEqual({
        ...policy,
        socket: { future: "keep" },
      });
    }
    const localPath = resolveClientCredentialStorePath(f.env);
    const orphan = fs.readFileSync(localPath);
    await rollback(f, captured);
    {
      using restored = openNodeSqliteDatabase(f.pathname, { readOnly: true });
      expect(restored.prepare("SELECT * FROM exec_approvals_config").get()).toEqual(
        originalApprovals,
      );
    }
    expect(fs.existsSync(localPath)).toBe(false);
    // Released drivers leave this file behind when they restore shared state.
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, orphan, { mode: 0o600 });
    {
      using stale = openNodeSqliteDatabase(localPath);
      stale.prepare("UPDATE device_auth_tokens SET token=?").run("synthetic-orphan-token");
    }
    await migrate(f);
    expect(
      runClientCredentialOperation(f.env, {
        kind: "token.read",
        key: { device_id: identity.deviceId, role: "operator" },
      }),
    ).toMatchObject({ kind: "token", token: { token: "synthetic-original-token" } });
  });

  it("captures and restores only the canonical v28 credential migration scope", async () => {
    const f = await fixture("sqlite", false, 28);
    const sourceTables = [...credentialTables, "exec_approvals_config"];
    let original;
    {
      using shared = openNodeSqliteDatabase(f.pathname);
      expect(
        shared.prepare("SELECT wr FROM pragma_table_list WHERE name='session_state_heads'").get(),
      ).toEqual({ wr: 1 });
      shared.exec(`INSERT INTO session_state_heads VALUES ('scope-proof','main',73,7,1); ANALYZE;`);
      original = Object.fromEntries(
        sourceTables.map((table) => [table, shared.prepare(`SELECT * FROM ${table}`).all()]),
      );
    }
    await migrate(f);
    const archives = fs
      .readdirSync(path.dirname(f.pathname))
      .filter((name) => name.endsWith(".scoped.bak"))
      .map((name) => {
        const pathname = path.join(path.dirname(f.pathname), name);
        return { pathname, inspection: inspectScopedMigrationSnapshot(pathname) };
      });
    expect(archives).toHaveLength(2);
    const versionBackup = archives.find(({ inspection }) =>
      inspection.tables.some((table) => table.name === "schema_meta"),
    )!;
    expect(versionBackup.inspection).toMatchObject({ sourcePath: f.pathname, userVersion: 28 });
    expect(versionBackup.inspection.tables.map((table) => table.name)).toEqual(
      [
        ...sourceTables,
        "config_machine_state",
        "local_workspace_projections",
        "local_workspace_manifest_nodes",
        "local_workspace_source_path_sets",
        "local_workspace_tree_packs",
        "schema_meta",
        "sqlite_stat1",
        "sqlite_stat4",
      ].toSorted(),
    );
    const retirementBackup = archives.find((archive) => archive !== versionBackup)!;
    expect(retirementBackup.inspection).toMatchObject({ sourcePath: f.pathname, userVersion: 28 });
    expect(retirementBackup.inspection.tables.map((table) => table.name)).toEqual(
      sourceTables.concat("sqlite_stat1", "sqlite_stat4"),
    );
    {
      using shared = openNodeSqliteDatabase(f.pathname);
      shared.exec(
        "UPDATE session_state_heads SET last_sequence=74 WHERE session_key='scope-proof'",
      );
    }
    await restoreDoctorMigrationBackup({
      sourcePath: f.pathname,
      backupPath: versionBackup.pathname,
      env: f.env,
    });
    expect(await f.readShared()).toEqual({
      version: 28,
      token: "synthetic-original-token",
      policy,
    });
    using restored = openNodeSqliteDatabase(f.pathname, { readOnly: true });
    for (const table of sourceTables) {
      expect(restored.prepare(`SELECT * FROM ${table}`).all()).toEqual(original[table]);
    }
    expect(restored.prepare("SELECT * FROM session_state_heads").all()).toEqual([
      {
        session_key: "scope-proof",
        agent_id: "main",
        last_sequence: 74,
        pruned_max_sequence: 7,
        updated_at: 1,
      },
    ]);
    expect(
      restored.prepare("SELECT wr FROM pragma_table_list WHERE name='session_state_heads'").get(),
    ).toEqual({ wr: 1 });
  });

  it.each([25, 28] as const)(
    "migrates legacy STAT4 credentials from v%s while retaining their original rollback image",
    async (version) => {
      const f = await fixture("sqlite", false, version, "legacy-statistics");
      await migrate(f);
      const archives = fs
        .readdirSync(path.dirname(f.pathname))
        .filter((name) => name.endsWith(".bak"));
      expect(archives).toHaveLength(stat4Enabled ? 2 : 1);
      for (const archive of archives.filter((name) => !name.endsWith(".scoped.bak"))) {
        const backupPath = path.join(path.dirname(f.pathname), archive);
        using saved = openNodeSqliteDatabase(backupPath, { readOnly: true });
        expect(saved.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
        expect(saved.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
          token: "synthetic-original-token",
        });
        expect(saved.prepare("SELECT count(*) AS count FROM sqlite_stat4").get()).toEqual({
          count: 0,
        });
        using local = openClientCredentialCustody(f.env, { migration: true })!;
        expect(readClientCredentialReceipt(local.database)?.receipt.source?.generation).toBe(
          createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex"),
        );
      }
    },
  );

  it.skipIf(stat4Enabled).each([false, true])(
    "reuses a legacy STAT4 retry image only while credentials match (changed=%s)",
    async (changed) => {
      const f = await fixture("sqlite", false, 28, "legacy-statistics");
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true, nonInteractive: true },
        runtime: { log() {}, error() {}, exit() {} },
      });
      try {
        await maintenance!.run(() =>
          backupDoctorMigrationDatabases({
            env: f.env,
            databasePaths: [f.pathname],
            pendingDatabasePaths: [f.pathname],
            pendingMigrations: [
              {
                kind: "state",
                path: f.pathname,
                foundVersion: 28,
                supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
              },
            ],
            versionMigrationsOnly: true,
          }),
        );
      } finally {
        await maintenance!.release();
      }
      const archive = fs
        .readdirSync(path.dirname(f.pathname))
        .find((name) => name.endsWith(".bak"))!;
      const backupPath = path.join(path.dirname(f.pathname), archive);
      const original = fs.readFileSync(backupPath);
      if (changed) {
        using source = openNodeSqliteDatabase(f.pathname);
        source.prepare("UPDATE device_auth_tokens SET token=?").run("synthetic-rotated-token");
      }
      if (changed) {
        await expect(migrate(f)).rejects.toThrow(/no longer contains current credentials/);
        expect(await f.readShared()).toMatchObject({
          version: 28,
          token: "synthetic-rotated-token",
        });
      } else {
        await migrate(f);
      }
      expect(fs.readFileSync(backupPath)).toEqual(original);
    },
  );

  it("preserves native bootstrap on updater refusal and migrates it through standalone Doctor", async () => {
    const f = await fixture("sqlite", true);
    const sourceTables = credentialTables.slice(0, 2);
    const inspect = (db: ReturnType<typeof openNodeSqliteDatabase>) => ({
      credentials: Object.fromEntries(
        sourceTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
      ),
      indexes: db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type='index' AND tbl_name IN ('device_identities','device_auth_tokens') ORDER BY name",
        )
        .all(),
      statistics: Object.fromEntries(
        ["sqlite_stat1", "sqlite_stat4"]
          .filter((table) => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table))
          .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      ),
    });
    const original = (() => {
      using source = openNodeSqliteDatabase(f.pathname);
      source.exec("ANALYZE");
      return inspect(source);
    })();
    expect(original.statistics.sqlite_stat1).toEqual(
      expect.arrayContaining([expect.objectContaining({ tbl: "device_identities" })]),
    );
    const before = fs.readFileSync(f.pathname);
    expect(() => createUpdateRun({ trigger: "cli" }, { env: f.env })).toThrow(
      /schema role missing/,
    );
    expect(fs.readFileSync(f.pathname)).toEqual(before);
    expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
    await migrate(f);
    const backups = fs
      .readdirSync(path.dirname(f.pathname))
      .filter(
        (name) =>
          name.startsWith("openclaw.sqlite.pre-startup-migration-") && name.endsWith(".scoped.bak"),
      );
    expect(backups).toHaveLength(1);
    const backupPath = path.join(path.dirname(f.pathname), backups[0]!);
    const backup = inspectScopedMigrationSnapshot(backupPath);
    expect(backup.sourcePath).toBe(f.pathname);
    expect(backup.userVersion).toBe(0);
    {
      using shared = openNodeSqliteDatabase(f.pathname, { readOnly: true });
      expect(shared.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        shared.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
      ).toBeUndefined();
      expect(
        shared.prepare("SELECT * FROM sqlite_stat1 WHERE tbl='device_identities'").all(),
      ).toEqual([]);
    }
    await restoreDoctorMigrationBackup({ sourcePath: f.pathname, backupPath, env: f.env });
    using restored = openNodeSqliteDatabase(f.pathname, { readOnly: true });
    expect(inspect(restored)).toEqual(original);
    expect(backup.tables.map((table) => table.name)).toEqual([
      ...credentialTables,
      "exec_approvals_config",
      "sqlite_stat1",
      "sqlite_stat4",
    ]);
  });

  it("refuses a foreign shared write after capture without retiring credentials", async () => {
    const f = await fixture("sqlite");
    const captured = await capture(f);
    {
      using shared = openNodeSqliteDatabase(f.pathname);
      shared.prepare("UPDATE device_auth_tokens SET token=?").run("synthetic-foreign-token");
    }
    await expect(migrate(f, captured)).rejects.toThrow(/changed|capture|generation|custody/i);
    expect(await f.readShared()).toEqual({ version: 25, token: "synthetic-foreign-token", policy });
    expect(() =>
      runClientCredentialOperation(f.env, { kind: "identity.read", identity_key: "primary" }),
    ).toThrow();
  });
});

describe.skipIf(!connection)("client credential PostgreSQL public update custody", () => {
  it("captures PostgreSQL before cutover and restores shared credentials through public rollback", async () => {
    const f = await fixture("postgres");
    const captured = await capture(f);
    expect(await f.readShared()).toEqual({
      version: f.sourceVersion,
      token: "synthetic-original-token",
      policy,
    });
    await migrate(f, captured);
    await rollback(f, captured);
    expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
  });

  it("migrates PostgreSQL credentials through standalone Doctor and retains an exact backup", async () => {
    const f = await fixture("postgres");
    const registrar = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);
    const moduleUrl = (relative: string) => JSON.stringify(new URL(relative, registrar).href);
    const child = spawnNodeEvalSync(
      `
        const { installDatabaseEngineSelection } = await import(${moduleUrl("../../infra/database-engine/context.js")});
        const { resolveDatabaseFamilyEngines } = await import(${moduleUrl("../../infra/database-engine/registry.js")});
        const { beginDoctorMaintenance } = await import(${moduleUrl("../../commands/doctor-maintenance.js")});
        const { prepareDoctorDatabaseMigrations } = await import(${moduleUrl("../../commands/doctor-schema-migrations.js")});
        const { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } = await import(${moduleUrl("../../state/openclaw-state-db.js")});
        const { withEngineStoreAdmission } = await import(${moduleUrl("../../infra/database-engine/admission-scope.js")});
        const { assertDoctorAgentLeaseAdmission } = await import(${moduleUrl("../../commands/doctor-agent-lease-refusal.js")});
        installDatabaseEngineSelection({
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
          postgres: { connection: process.env.OPENCLAW_TEST_POSTGRES_CONNECTION, schemaPrefix: "client_update" },
        });
        const maintenance = await beginDoctorMaintenance({
          root: null, options: { repair: true, nonInteractive: true },
          runtime: { log() {}, error() {}, exit(code) { throw new Error("Unexpected exit " + code); } },
        });
        if (!maintenance) throw new Error("Doctor did not acquire maintenance");
        try {
          const outcome = await maintenance.run(() => prepareDoctorDatabaseMigrations({
            env: process.env,
            databasePaths: [${JSON.stringify(f.pathname)}],
            pendingDatabasePaths: [${JSON.stringify(f.pathname)}],
            pendingMigrations: [{ kind: "state", path: ${JSON.stringify(f.pathname)}, foundVersion: 25,
              supportedVersion: ${OPENCLAW_STATE_SCHEMA_VERSION} }],
          }));
          if (outcome.warnings.length) throw new Error(outcome.warnings.join("\\n"));
          maintenance.run(() =>
            withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: process.env })),
          );
          await maintenance.run(() => assertDoctorAgentLeaseAdmission(process.env));
        } finally {
          await maintenance.release();
          await closeOpenClawStateDatabaseAsync();
        }
      `,
      {
        env: {
          ...f.env,
          NODE_ENV: "production",
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          OPENCLAW_TEST_POSTGRES_CONNECTION: connection,
        },
        timeout: 60_000,
      },
    );
    expect(
      { status: child.status, signal: child.signal, error: child.error },
      child.stderr,
    ).toEqual({
      status: 0,
      signal: null,
      error: undefined,
    });
    assertMigratedCredentials(f);
    expect(readBackupEngine(f.pathname).engine).toBe("postgres");
    const backups = fs
      .readdirSync(path.dirname(f.pathname))
      .filter((name) => name.endsWith(".postgres.bak"));
    expect(backups).toHaveLength(1);
    const backupPath = path.join(path.dirname(f.pathname), backups[0]!);
    const manifest = await verifyMatchedPostgresBackup(backupPath, "exact");
    expect(manifest.source.schemaVersion).toBe(25);
    using image = openNodeSqliteDatabase(path.join(backupPath, "database.sqlite"), {
      readOnly: true,
    });
    expect(image.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
      token: "synthetic-original-token",
    });
  });

  it("refuses native bootstrap before selecting PostgreSQL and gives the SQLite recovery path", async () => {
    const f = await fixture("postgres", true);
    const before = fs.readFileSync(f.pathname);
    expect(() => withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: f.env }))).toThrow(
      /Start the Gateway once on SQLite and run openclaw doctor --fix, then use openclaw database port/,
    );
    expect(fs.readFileSync(f.pathname)).toEqual(before);
    expect(readBackupEngine(f.pathname).engine).toBe("sqlite");
    expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
  });
});
