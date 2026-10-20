import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePublicSessionShareToken } from "../gateway/control-ui-public-session-token.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db-contract.js";
import {
  executeCanonicalStateSchema,
  writeCurrentStateSchemaMetadata,
} from "../state/openclaw-state-db-maintenance.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { importClientCredentialLegacy } from "./client-credential-legacy.js";
import {
  prepareClientCredentialMigration,
  bindFreshClientCredentialStore,
  recoverClientCredentialStore,
} from "./client-credential-migration.js";
import { readIndependentClientCredentialSource } from "./client-credential-native-bootstrap.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import { serializeClientCredentialReceipt } from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "./client-credential-store.js";
import { createLegacyNodeAuthFixture } from "./client-credential-store.test-support.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
async function captureFixture(sourcePath: string) {
  await createVerifiedSqliteSnapshot({ sourcePath, targetPath: `${sourcePath}.captured` });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess(pathname) {
      expect(pathname).toBe(sourcePath);
    },
  });
  maintenance.run(() => admitOpenClawMaintenanceLiveAuthorityReads(sourcePath));
  return Object.assign(maintenance, {
    capture: {
      path: sourcePath,
      generation: createHash("sha256")
        .update(fs.readFileSync(`${sourcePath}.captured`))
        .digest("hex"),
      assertCurrent: maintenance.assertAdmission,
    },
  });
}

async function fixture(customKeys = false) {
  const root = dirs.make("client-migration-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const sourcePath = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const source = openNodeSqliteDatabase(sourcePath);
  source.exec(
    CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
      0,
      CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE native_exec_socket_credentials"),
    ),
  );
  source.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "exec_approvals_config"));
  source.exec(
    "CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, created_at INTEGER, schema_version INTEGER); INSERT INTO schema_meta VALUES ('primary',123,25); CREATE TABLE migration_sources(migration_kind TEXT); CREATE TABLE unaffected(value TEXT); INSERT INTO unaffected VALUES ('preserve'); PRAGMA user_version=25;",
  );
  const privateKey = createPrivateKey({
    key: Buffer.from(
      "302e020100300506032b657004220420" +
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const identity = {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
    deviceId: createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }).subarray(-32))
      .digest("hex"),
    createdAtMs: 12,
  };
  source
    .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
    .run(
      "primary",
      identity.deviceId,
      identity.publicKeyPem,
      identity.privateKeyPem,
      identity.createdAtMs,
      99,
    );
  source
    .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
    .run(identity.deviceId, "v2.gateway.operator", "token-original", '["operator.read"]', 101);
  source
    .prepare("INSERT INTO gateway_origin_device_tokens VALUES (?,?,?,?,?,?)")
    .run(
      "https://gateway.example",
      identity.deviceId,
      "operator",
      "origin-token",
      '["operator.write"]',
      102,
    );
  const policy = {
    version: 1,
    socket: { path: "/socket", token: "socket-token", future: "keep" },
    defaults: { security: "deny" },
    agents: {},
  };
  source
    .prepare("INSERT INTO exec_approvals_config VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("current", JSON.stringify(policy), "/socket", 1, "deny", null, null, null, 0, 0, 55);
  if (customKeys) {
    source
      .prepare(
        "INSERT INTO device_identities SELECT ?,device_id,public_key_pem,private_key_pem,created_at_ms,updated_at_ms FROM device_identities WHERE identity_key='primary'",
      )
      .run("é/custom");
    source
      .prepare(
        "INSERT INTO device_auth_tokens SELECT device_id,?,token,?,updated_at_ms FROM device_auth_tokens LIMIT 1",
      )
      .run("é/gateway\u0301", '[ "scope/é", "control\\nvalue" ]');
  }
  const maintenance = await captureFixture(sourcePath);
  return { source, sourcePath, env, identity, maintenance };
}

function nativeFixture(unrecognized = false) {
  const root = dirs.make("native-client-bootstrap-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const sourcePath = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const source = openNodeSqliteDatabase(sourcePath);
  source.exec(
    CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
      0,
      CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE gateway_origin_device_tokens"),
    ),
  );
  const identity = generateStoredDeviceIdentity(7);
  source
    .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
    .run("primary", identity.deviceId, identity.publicKeyPem, identity.privateKeyPem, 7, 8);
  if (unrecognized) {
    source.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('retain');");
  }
  source.close();
  return { env, sourcePath, identity };
}

describe("local client credential extraction", () => {
  it("requires captured owner extraction for native-v0 credentials and preserves the runtime identity", async () => {
    const f = nativeFixture();
    expect(() => openOpenClawStateDatabase({ env: f.env })).toThrow(/backed-up migration custody/);
    closeOpenClawStateDatabaseForTest();
    const maintenance = await captureFixture(f.sourcePath);
    try {
      // Unit setup supplies the captured owner boundary explicitly. Installed-driver
      // schema-runtime attribution remains a separate R14b integration requirement.
      {
        using source = openNodeSqliteDatabase(f.sourcePath);
        maintenance.run(() =>
          runSqliteImmediateTransactionSync(source, () => {
            prepareClientCredentialMigration(source, {
              path: f.sourcePath,
              env: f.env,
              fromVersion: 0,
              capture: maintenance.capture,
            });
            executeCanonicalStateSchema(source, { includeVersionLazyAdditiveTables: true });
            writeCurrentStateSchemaMetadata(source, 42);
          }),
        );
      }
      const shared = maintenance.run(() => openOpenClawStateDatabase({ env: f.env }));
      expect(shared.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        shared.db.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
      ).toBeUndefined();
      expect(
        runClientCredentialOperation(f.env, { kind: "identity.read", identity_key: "primary" }),
      ).toMatchObject({
        kind: "identity",
        identity: { device_id: f.identity.deviceId, private_key_pem: f.identity.privateKeyPem },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      await maintenance.close();
    }
  });

  it.each([false, true])(
    "treats native auth absence as authoritative only when its table existed (table: %s)",
    async (authTablePresent) => {
      const f = nativeFixture();
      if (!authTablePresent) {
        using source = openNodeSqliteDatabase(f.sourcePath);
        source.exec("DROP TABLE device_auth_tokens");
      }
      const root = f.env.OPENCLAW_STATE_DIR;
      const legacyPath = path.join(root, "identity", "device-auth.json");
      const raw = JSON.stringify({
        version: 1,
        deviceId: f.identity.deviceId,
        tokens: { operator: { token: "same-root-json-token", scopes: [], updatedAtMs: 10 } },
      });
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, raw);
      const maintenance = await captureFixture(f.sourcePath);
      try {
        {
          using source = openNodeSqliteDatabase(f.sourcePath);
          maintenance.run(() =>
            runSqliteImmediateTransactionSync(source, () => {
              prepareClientCredentialMigration(source, {
                path: f.sourcePath,
                env: f.env,
                fromVersion: 0,
                capture: maintenance.capture,
              });
              executeCanonicalStateSchema(source, { includeVersionLazyAdditiveTables: true });
              writeCurrentStateSchemaMetadata(source, 42);
            }),
          );
        }
        {
          using local = openClientCredentialCustody(f.env, { migration: true })!;
          expect(
            readClientCredentialReceipt(local.database)?.receipt.legacyImports["auth:primary"],
          ).toEqual(authTablePresent ? { sha256: null } : undefined);
        }
        const imported = await migrateLegacyDeviceAuth({
          env: f.env,
          stateDir: root,
          detected: detectLegacyDeviceAuth({ stateDir: root, doctorOnlyStateMigrations: true }),
        });
        expect(imported.warnings).toEqual([]);
        expect(
          runClientCredentialOperation(f.env, {
            kind: "token.read",
            key: { device_id: f.identity.deviceId, role: "operator" },
          }),
        ).toMatchObject({
          kind: "token",
          token: authTablePresent ? null : { token: "same-root-json-token" },
        });
        expect(fs.readFileSync(legacyPath, "utf8")).toBe(raw);
      } finally {
        closeOpenClawStateDatabaseForTest();
        await maintenance.close();
      }
    },
  );

  it("refuses unrecognized native-v0 objects without retiring credentials", () => {
    const f = nativeFixture(true);
    try {
      expect(() => openOpenClawStateDatabase({ env: f.env })).toThrow(
        /Unrecognized native bootstrap/,
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
    using source = openNodeSqliteDatabase(f.sourcePath, { readOnly: true });
    expect(source.prepare("SELECT device_id FROM device_identities").get()).toEqual({
      device_id: f.identity.deviceId,
    });
    expect(source.prepare("SELECT value FROM unrelated").get()).toEqual({ value: "retain" });
    expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
  });

  it("binds fresh shared bootstrap without replacing an identity created before the Gateway", () => {
    const root = dirs.make("client-fresh-bootstrap-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const identity = generateStoredDeviceIdentity(17);
    runClientCredentialOperation(env, {
      kind: "identity.create",
      identity: {
        identity_key: "primary",
        device_id: identity.deviceId,
        public_key_pem: identity.publicKeyPem,
        private_key_pem: identity.privateKeyPem,
        created_at_ms: 17,
        updated_at_ms: 17,
      },
    });
    try {
      const shared = openOpenClawStateDatabase({ env });
      expect(
        shared.db.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
      ).toBeUndefined();
      const read = runClientCredentialOperation(env, {
        kind: "identity.read",
        identity_key: "primary",
      });
      expect(read).toMatchObject({ kind: "identity", identity: { device_id: identity.deviceId } });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("preserves local identity when the first PostgreSQL connection fails", async () => {
    const root = dirs.make("client-postgres-unavailable-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const material = generateStoredDeviceIdentity(17);
    const identity = {
      identity_key: "primary",
      device_id: material.deviceId,
      public_key_pem: material.publicKeyPem,
      private_key_pem: material.privateKeyPem,
      created_at_ms: 17,
      updated_at_ms: 19,
    };
    runClientCredentialOperation(env, { kind: "identity.create", identity });
    const reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () => net.createServer(),
    });
    try {
      await reservation.releaseListener();
      let entered = false;
      expect(() =>
        withDatabaseEngineSelection(
          {
            effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
            postgres: {
              connection: `postgresql://synthetic@127.0.0.1:${reservation.claim.port}/synthetic`,
              schemaPrefix: "client_unavailable",
            },
          },
          () =>
            withEngineStoreAdmission(() =>
              runOpenClawStateWriteTransaction(
                () => {
                  entered = true;
                },
                { env },
              ),
            ),
        ),
      ).toThrow(/ECONNREFUSED/);
      expect(entered).toBe(false);
      expect(fs.existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(true);
      expect(
        runClientCredentialOperation(
          env,
          { kind: "identity.read", identity_key: "primary" },
          {
            readOnly: true,
          },
        ),
      ).toEqual({ kind: "identity", identity });
    } finally {
      closeOpenClawStateDatabaseForTest();
      await reservation.claim.release();
    }
  });

  it("keeps source-free recovery on its recorded file and refuses an unrelated replacement", async () => {
    const root = dirs.make("client-fresh-recovery-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const otherEnv = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("client-unrelated-state-") };
    const sharedPath = path.join(root, "state", "openclaw.sqlite");
    const material = generateStoredDeviceIdentity(17);
    const identity = {
      identity_key: "primary",
      device_id: material.deviceId,
      public_key_pem: material.publicKeyPem,
      private_key_pem: material.privateKeyPem,
      created_at_ms: 17,
      updated_at_ms: 19,
    };
    runClientCredentialOperation(env, { kind: "identity.create", identity });
    try {
      openOpenClawStateDatabase({ env });
      await closeOpenClawStateDatabaseAsync();
      {
        using local = openClientCredentialCustody(env, { migration: true })!;
        const stored = readClientCredentialReceipt(local.database)!;
        expect(stored.receipt.source).toBeNull();
        writeClientCredentialReceipt(local.database, stored.receipt, "copied");
      }
      repairOpenClawStateDatabaseSchema({ env, versionMigrationOnly: true });
      expect(
        runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
      ).toEqual({ kind: "identity", identity });

      openOpenClawStateDatabase({ env: otherEnv });
      await closeOpenClawStateDatabaseAsync();
      fs.renameSync(sharedPath, `${sharedPath}.original`);
      fs.copyFileSync(
        path.join(otherEnv.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
        sharedPath,
      );
      const localPath = resolveClientCredentialStorePath(env);
      const before = fs.readFileSync(localPath);
      expect(() =>
        runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
      ).toThrow("migration is incomplete or stale");
      const repair = repairOpenClawStateDatabaseSchema({ env, versionMigrationOnly: true });
      expect(repair.changes).toEqual([]);
      expect(repair.warnings).toEqual([
        expect.stringContaining("Local credentials do not match the shared database"),
      ]);
      expect(fs.readFileSync(localPath)).toEqual(before);
      expect(() =>
        runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
      ).toThrow("migration is incomplete or stale");
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });

  it("preserves exact identity and scopes, strips only socket material, then retires source tables", async () => {
    const f = await fixture();
    try {
      f.maintenance.run(() =>
        runSqliteImmediateTransactionSync(f.source, () =>
          prepareClientCredentialMigration(f.source, {
            path: f.sourcePath,
            env: f.env,
            fromVersion: 25,
            capture: f.maintenance.capture,
          }),
        ),
      );
      const target = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        expect(target.database.prepare("SELECT * FROM device_identities").get()).toEqual({
          identity_key: "primary",
          device_id: f.identity.deviceId,
          public_key_pem: f.identity.publicKeyPem,
          private_key_pem: f.identity.privateKeyPem,
          created_at_ms: 12,
          updated_at_ms: 99,
        });
        expect(
          target.database.prepare("SELECT token,role,scopes_json FROM device_auth_tokens").get(),
        ).toEqual({
          token: "token-original",
          role: "v2.gateway.operator",
          scopes_json: '["operator.read"]',
        });
        expect(
          target.database
            .prepare("SELECT socket_path,socket_token FROM native_exec_socket_credentials")
            .get(),
        ).toEqual({ socket_path: "/socket", socket_token: "socket-token" });
        expect(readClientCredentialReceipt(target.database)?.phase).toBe("complete");
      } finally {
        target.close();
      }
      expect(
        f.source.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
      ).toBeUndefined();
      const row = f.source
        .prepare(
          "SELECT raw_json,socket_path,has_socket_token,updated_at_ms FROM exec_approvals_config",
        )
        .get()!;
      expect(JSON.parse(String(row.raw_json))).toEqual({
        version: 1,
        socket: { future: "keep" },
        defaults: { security: "deny" },
        agents: {},
      });
      expect(row).toMatchObject({ socket_path: null, has_socket_token: 0, updated_at_ms: 55 });
      expect(f.source.prepare("SELECT value FROM unaffected").get()).toEqual({ value: "preserve" });
    } finally {
      f.source.close();
      await f.maintenance.close();
    }
  });

  it("leaves copied on source rollback and rebuilds an orphan without merging newer cached tokens", async () => {
    const f = await fixture();
    const legacyPath = path.join(f.env.OPENCLAW_STATE_DIR, "identity", "node-device-auth.json");
    const {
      token: legacyToken,
      raw: legacyJson,
      legacyImport,
    } = createLegacyNodeAuthFixture(f.identity.deviceId);
    try {
      expect(() =>
        f.maintenance.run(() =>
          runSqliteImmediateTransactionSync(f.source, () => {
            prepareClientCredentialMigration(f.source, {
              path: f.sourcePath,
              env: f.env,
              fromVersion: 25,
              capture: f.maintenance.capture,
            });
            throw new Error("interrupt before shared commit");
          }),
        ),
      ).toThrow("interrupt before shared commit");
      const target = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        expect(readClientCredentialReceipt(target.database)?.phase).toBe("copied");
        runSqliteImmediateTransactionSync(target.database, () =>
          target.database.exec(
            "UPDATE device_auth_tokens SET token='orphan-token'; UPDATE client_credential_migration SET phase='complete';",
          ),
        );
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, legacyJson);
        expect(importClientCredentialLegacy(target, legacyImport)).toBe(true);
        expect(
          target.run({
            kind: "token.remove",
            key: legacyToken,
            observedToken: legacyToken.token,
          }),
        ).toEqual({ kind: "changed", changed: true });
      } finally {
        target.close();
      }
      expect(f.source.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
        token: "token-original",
      });
      expect(f.source.prepare("SELECT identity_key FROM device_identities").all()).toEqual([
        { identity_key: "primary" },
      ]);
      f.maintenance.run(() =>
        runSqliteImmediateTransactionSync(f.source, () =>
          prepareClientCredentialMigration(f.source, {
            path: f.sourcePath,
            env: f.env,
            fromVersion: 25,
            capture: f.maintenance.capture,
          }),
        ),
      );
      const current = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        expect(current.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
          token: "token-original",
        });
        const imported = importClientCredentialLegacy(current, legacyImport);
        expect(current.run({ kind: "token.read", key: legacyToken })).toEqual({
          kind: "token",
          token: null,
        });
        expect(imported).toBe(false);
        expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyJson);
      } finally {
        current.close();
      }
    } finally {
      f.source.close();
      await f.maintenance.close();
    }
  });

  it("copies invalid canonical identity bytes exactly and keeps ordinary reads fail-closed", async () => {
    const f = await fixture();
    try {
      const differentIdentity = generateStoredDeviceIdentity(21);
      f.source
        .prepare("UPDATE device_identities SET private_key_pem=?")
        .run(differentIdentity.privateKeyPem);
      const sourceRow = f.source.prepare("SELECT * FROM device_identities").get();
      f.maintenance.run(() =>
        runSqliteImmediateTransactionSync(f.source, () =>
          prepareClientCredentialMigration(f.source, {
            path: f.sourcePath,
            env: f.env,
            fromVersion: 25,
            capture: f.maintenance.capture,
          }),
        ),
      );
      {
        using local = openClientCredentialCustody(f.env, {
          createIfMissing: false,
          migration: true,
        })!;
        expect(local.database.prepare("SELECT * FROM device_identities").get()).toEqual(sourceRow);
        expect(readClientCredentialReceipt(local.database)).toMatchObject({
          phase: "complete",
          receipt: { legacyImports: { "identity:primary": { sha256: null } } },
        });
      }
      expect(
        f.source.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
      ).toBeUndefined();
      expect(() =>
        runClientCredentialOperation(f.env, { kind: "identity.read", identity_key: "primary" }),
      ).toThrow(/invalid persisted device identity/);
    } finally {
      f.source.close();
      await f.maintenance.close();
    }
  });

  it("retains shared credentials and socket material when token scope validation fails", async () => {
    const f = await fixture();
    try {
      f.source.prepare("UPDATE device_auth_tokens SET scopes_json='{}'").run();
      expect(() =>
        f.maintenance.run(() =>
          runSqliteImmediateTransactionSync(f.source, () =>
            prepareClientCredentialMigration(f.source, {
              path: f.sourcePath,
              env: f.env,
              fromVersion: 25,
              capture: f.maintenance.capture,
            }),
          ),
        ),
      ).toThrow("invalid token record");
      expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
      expect(f.source.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
        token: "token-original",
      });
      expect(f.source.prepare("SELECT raw_json FROM exec_approvals_config").get()).toEqual({
        raw_json: JSON.stringify({
          version: 1,
          socket: { path: "/socket", token: "socket-token", future: "keep" },
          defaults: { security: "deny" },
          agents: {},
        }),
      });
    } finally {
      f.source.close();
      await f.maintenance.close();
    }
  });

  it("finishes an interrupted local publication only against the already-retired source", async () => {
    const f = await fixture();
    try {
      f.maintenance.run(() =>
        runSqliteImmediateTransactionSync(f.source, () =>
          prepareClientCredentialMigration(f.source, {
            path: f.sourcePath,
            env: f.env,
            fromVersion: 25,
            capture: f.maintenance.capture,
          }),
        ),
      );
      const target = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        runSqliteImmediateTransactionSync(target.database, () =>
          target.database.prepare("UPDATE client_credential_migration SET phase='copied'").run(),
        );
      } finally {
        target.close();
      }
      f.source.exec(
        `UPDATE schema_meta SET schema_version=${CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION}; PRAGMA user_version=${CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION};`,
      );
      recoverClientCredentialStore(f.source, { path: f.sourcePath, env: f.env });
      const current = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        expect(readClientCredentialReceipt(current.database)?.phase).toBe("complete");
      } finally {
        current.close();
      }
      expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(true);
    } finally {
      f.source.close();
      await f.maintenance.close();
    }
  });

  it("resumes after committed retirement while an older updater defers the published header", async () => {
    const f = await fixture();
    try {
      f.maintenance.run(() =>
        runSqliteImmediateTransactionSync(f.source, () =>
          prepareClientCredentialMigration(f.source, {
            path: f.sourcePath,
            env: f.env,
            fromVersion: 25,
            capture: f.maintenance.capture,
          }),
        ),
      );
      const target = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        runSqliteImmediateTransactionSync(target.database, () =>
          target.database.prepare("UPDATE client_credential_migration SET phase='copied'").run(),
        );
      } finally {
        target.close();
      }
      f.source.exec(
        `CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT); INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','${CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION}');`,
      );
      expect(f.source.prepare("PRAGMA user_version").get()).toEqual({ user_version: 25 });
      recoverClientCredentialStore(f.source, { path: f.sourcePath, env: f.env });
      const recovered = openClientCredentialCustody(f.env, {
        createIfMissing: false,
        migration: true,
      })!;
      try {
        expect(readClientCredentialReceipt(recovered.database)?.phase).toBe("complete");
      } finally {
        recovered.close();
      }
    } finally {
      f.source.close();
      await f.maintenance.close();
    }
  });
});

it("checks the Swift receipt fixture against actual canonical migration output", async () => {
  const f = await fixture(true);
  try {
    f.maintenance.run(() =>
      runSqliteImmediateTransactionSync(f.source, () =>
        prepareClientCredentialMigration(f.source, {
          path: f.sourcePath,
          env: f.env,
          fromVersion: 25,
          capture: f.maintenance.capture,
        }),
      ),
    );
    using target = openClientCredentialCustody(f.env, { createIfMissing: false, migration: true })!;
    const actual = readClientCredentialReceipt(target.database)!;
    expect(actual.receipt.source!.generation).toBe(f.maintenance.capture.generation);
    expect(actual.receipt.source!.generation).toMatch(/^[a-f0-9]{64}$/u);
    // Physical backup bytes vary across SQLite builds; keep the logical source hash exact.
    actual.receipt.source!.generation = "0".repeat(64);
    actual.receipt.sharedFile = { path: "/fixture/state/openclaw.sqlite", dev: "1", ino: "2" };
    actual.receipt.source!.identity = "/fixture/state/openclaw.sqlite:123";
    const freshRoot = dirs.make("client-fresh-receipt-");
    const freshEnv = { ...process.env, OPENCLAW_STATE_DIR: freshRoot };
    const freshPath = path.join(freshRoot, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(freshPath), { recursive: true });
    using fresh = openNodeSqliteDatabase(freshPath);
    runSqliteImmediateTransactionSync(fresh, () =>
      bindFreshClientCredentialStore(fresh, { path: freshPath, env: freshEnv }),
    );
    using freshOwner = openClientCredentialCustody(freshEnv, {
      createIfMissing: false,
      migration: true,
    })!;
    const freshStored = readClientCredentialReceipt(freshOwner.database)!;
    freshStored.receipt.sharedFile = { path: "/fixture/state/openclaw.sqlite", dev: "1", ino: "2" };
    const fixtureReceipt = (name: string, stored: typeof actual, rootPath?: string) => ({
      name,
      phase: stored.phase,
      source_store: serializeClientCredentialReceipt(stored.receipt, rootPath),
    });
    const envelope = {
      format: 1,
      cases: [
        fixtureReceipt("canonical-sqlite", actual),
        fixtureReceipt("fresh-canonical-binding", freshStored),
        fixtureReceipt("canonical-relative-binding", actual, "/fixture"),
      ],
    };
    const fixturePath = path.resolve(
      "apps/shared/OpenClawKit/Tests/OpenClawNativeStateTests/Fixtures/ClientCredentials/receipts.json",
    );
    await expect(`${JSON.stringify(envelope, null, 2)}\n`).toMatchFileSnapshot(fixturePath);
  } finally {
    f.source.close();
    await f.maintenance.close();
  }
});

it("promotes an unchanged independent native source without losing refreshed local tokens or claims", async () => {
  const f = nativeFixture();
  const snapshot = readIndependentClientCredentialSource(f.sourcePath);
  {
    using local = openClientCredentialCustody(f.env, { createIfMissing: true, migration: true })!;
    runSqliteImmediateTransactionSync(local.database, () => {
      local.database
        .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
        .run(
          "primary",
          f.identity.deviceId,
          f.identity.publicKeyPem,
          f.identity.privateKeyPem,
          7,
          8,
        );
      local.database
        .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
        .run(f.identity.deviceId, "operator", "refreshed-after-import", "[]", 20);
      writeClientCredentialReceipt(
        local.database,
        {
          format: 1,
          source: {
            kind: "independent",
            engine: "native-v0",
            identity: snapshot.identity,
            generation: "0",
            sha256: snapshot.sha256,
            destinationVersion: 1,
          },
          sharedFile: snapshot.file,
          legacyImports: { "auth:primary": { sha256: "b".repeat(64) } },
        },
        "complete",
      );
    });
  }
  const maintenance = await captureFixture(f.sourcePath);
  using source = openNodeSqliteDatabase(f.sourcePath);
  try {
    maintenance.run(() =>
      runSqliteImmediateTransactionSync(source, () =>
        prepareClientCredentialMigration(source, {
          path: f.sourcePath,
          env: f.env,
          fromVersion: 0,
          capture: maintenance.capture,
        }),
      ),
    );
    using local = openClientCredentialCustody(f.env, { migration: true })!;
    expect(local.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
      token: "refreshed-after-import",
    });
    expect(readClientCredentialReceipt(local.database)).toMatchObject({
      phase: "complete",
      receipt: {
        source: { kind: "canonical", destinationVersion: 1 },
        legacyImports: { "auth:primary": { sha256: "b".repeat(64) } },
      },
    });
    expect(
      source.prepare("SELECT name FROM sqlite_schema WHERE name='device_auth_tokens'").get(),
    ).toBeUndefined();
  } finally {
    await maintenance.close();
  }
});

it("keeps revoked JSON credentials consumed when an independent native source changes", async () => {
  const f = nativeFixture();
  {
    using source = openNodeSqliteDatabase(f.sourcePath);
    source.exec("DROP TABLE device_auth_tokens");
  }
  const snapshot = readIndependentClientCredentialSource(f.sourcePath);
  const root = f.env.OPENCLAW_STATE_DIR;
  const legacyPath = path.join(root, "identity", "device-auth.json");
  const raw = JSON.stringify({
    version: 1,
    deviceId: f.identity.deviceId,
    tokens: { operator: { token: "revoked-json-token", scopes: [], updatedAtMs: 10 } },
  });
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, raw);
  {
    using local = openClientCredentialCustody(f.env, { createIfMissing: true, migration: true })!;
    runSqliteImmediateTransactionSync(local.database, () => {
      local.database
        .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
        .run(
          "primary",
          f.identity.deviceId,
          f.identity.publicKeyPem,
          f.identity.privateKeyPem,
          7,
          8,
        );
      writeClientCredentialReceipt(
        local.database,
        {
          format: 1,
          source: {
            kind: "independent",
            engine: "native-v0",
            identity: snapshot.identity,
            generation: "0",
            sha256: snapshot.sha256,
            destinationVersion: 1,
          },
          sharedFile: snapshot.file,
          legacyImports: {},
        },
        "complete",
      );
    });
  }
  const importLegacy = () =>
    migrateLegacyDeviceAuth({
      env: f.env,
      stateDir: root,
      detected: detectLegacyDeviceAuth({ stateDir: root, doctorOnlyStateMigrations: true }),
    });
  expect((await importLegacy()).warnings).toEqual([]);
  const key = { device_id: f.identity.deviceId, role: "operator" };
  expect(
    runClientCredentialOperation(f.env, {
      kind: "token.remove",
      key,
      expectedToken: "revoked-json-token",
    }),
  ).toEqual({ kind: "changed", changed: true });
  {
    using source = openNodeSqliteDatabase(f.sourcePath);
    source.prepare("UPDATE device_identities SET updated_at_ms=9").run();
  }
  expect(readIndependentClientCredentialSource(f.sourcePath).sha256).not.toBe(snapshot.sha256);
  const maintenance = await captureFixture(f.sourcePath);
  try {
    {
      using source = openNodeSqliteDatabase(f.sourcePath);
      maintenance.run(() =>
        runSqliteImmediateTransactionSync(source, () => {
          prepareClientCredentialMigration(source, {
            path: f.sourcePath,
            env: f.env,
            fromVersion: 0,
            capture: maintenance.capture,
          });
          executeCanonicalStateSchema(source, { includeVersionLazyAdditiveTables: true });
          writeCurrentStateSchemaMetadata(source, 42);
        }),
      );
    }
    expect((await importLegacy()).warnings).toEqual([]);
    expect(runClientCredentialOperation(f.env, { kind: "token.read", key })).toEqual({
      kind: "token",
      token: null,
    });
    using local = openClientCredentialCustody(f.env, { migration: true })!;
    expect(readClientCredentialReceipt(local.database)?.receipt.legacyImports).toEqual({
      "auth:primary": { sha256: createHash("sha256").update(raw).digest("hex") },
      "auth:node": { sha256: null },
      "auth:shareExtension": { sha256: null },
      "identity:primary": { sha256: null },
      "identity:node": { sha256: null },
      "identity:shareExtension": { sha256: null },
    });
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(raw);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await maintenance.close();
  }
});

it("decrypts a pre-cutover public-session token with the exactly migrated identity", async () => {
  const f = await fixture();
  // Minted by the v1 codec with the fixture's RFC 8032 private seed before storage cutover.
  const token =
    "v1.BwcHBwcHBwcHBwcHwqVwqlDFAwNPJ4TDoOKwRBzmmVH2zD4hlWSM9INXdYUuW35wvupzTDJq6OCFmLkD2varXqKRCJOHZq6zmCs_5a138mgvyTNU00swEQPLnTdZ5VEr2n-115k4EmS30yAm0EtylQ6rpbzjqNtSCCySwtnlYtDQrzcc-uV3cucEmEgsYpLSIf4qFVHiP0Ohc6JxVSv1xofWUQBR29jEQWdv9PyiJix1YE7n4vNCcEZA";
  try {
    f.maintenance.run(() =>
      runSqliteImmediateTransactionSync(f.source, () =>
        prepareClientCredentialMigration(f.source, {
          path: f.sourcePath,
          env: f.env,
          fromVersion: 25,
          capture: f.maintenance.capture,
        }),
      ),
    );
    await expect(resolvePublicSessionShareToken(token, { env: f.env })).resolves.toEqual({
      agentId: "synthetic",
      sessionKey: "agent:synthetic:public",
      sessionId: "migration-proof",
      shareId: "a".repeat(48),
    });
  } finally {
    f.source.close();
    await f.maintenance.close();
  }
});
