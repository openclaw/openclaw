import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePublicSessionShareToken } from "../gateway/control-ui-public-session-token.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
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
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { importClientCredentialLegacy } from "./client-credential-legacy.js";
import {
  prepareClientCredentialMigration,
  bindFreshClientCredentialStore,
  recoverClientCredentialStore,
} from "./client-credential-migration.js";
import {
  openMigrationCredentials,
  captureClientCredentialMigrationFixture,
  createClientCredentialMigrationFixture,
} from "./client-credential-migration.test-support.js";
import { readIndependentClientCredentialSource } from "./client-credential-native-bootstrap.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import { serializeClientCredentialReceipt } from "./client-credential-receipt.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { createLegacyNodeAuthFixture } from "./client-credential-store.test-support.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { detectLegacyDeviceAuth, migrateLegacyDeviceAuth } from "./state-migrations.device-auth.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture(customKeys = false, credentialRowCount = 1) {
  return createClientCredentialMigrationFixture(
    dirs.make("client-migration-"),
    customKeys,
    credentialRowCount,
  );
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

function upgradeNative(
  f: ReturnType<typeof nativeFixture>,
  maintenance: Awaited<ReturnType<typeof captureClientCredentialMigrationFixture>>,
) {
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

function seedIndependent(
  f: ReturnType<typeof nativeFixture>,
  snapshot: ReturnType<typeof readIndependentClientCredentialSource>,
  options: { token?: string; claimed?: boolean } = {},
) {
  using local = openMigrationCredentials(f.env, true);
  runSqliteImmediateTransactionSync(local.database, () => {
    local.database
      .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
      .run("primary", f.identity.deviceId, f.identity.publicKeyPem, f.identity.privateKeyPem, 7, 8);
    if (options.token) {
      local.database
        .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
        .run(f.identity.deviceId, "operator", options.token, "[]", 20);
    }
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
        legacyImports: options.claimed ? { "auth:primary": { sha256: "b".repeat(64) } } : {},
      },
      "complete",
    );
  });
}

describe("local client credential extraction", () => {
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
      const maintenance = await captureClientCredentialMigrationFixture(f.sourcePath);
      try {
        upgradeNative(f, maintenance);
        {
          using local = openMigrationCredentials(f.env);
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

  it("preserves an existing local identity when canonical shared state first opens", () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("client-fresh-bootstrap-") };
    const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(17), 19);
    runClientCredentialOperation(env, { kind: "identity.create", identity });
    {
      using local = openMigrationCredentials(env);
      expect(readClientCredentialReceipt(local.database)).toMatchObject({
        phase: "complete",
        receipt: { source: null, sharedFile: null },
      });
    }
    try {
      const shared = openOpenClawStateDatabase({ env });
      expect(
        shared.db.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
      ).toBeUndefined();
      expect(
        runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
      ).toEqual({ kind: "identity", identity });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });

  it("preserves local identity when the first PostgreSQL connection fails", async () => {
    const root = dirs.make("client-postgres-unavailable-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(17), 19);
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

  it.each(["copied", "complete"] as const)(
    "enriches a legacy %s bootstrap receipt only on its recorded file",
    async (phase) => {
      const root = dirs.make("client-fresh-recovery-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: root };
      const otherEnv = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("client-unrelated-state-") };
      const sharedPath = path.join(root, "state", "openclaw.sqlite");
      const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(17), 19);
      runClientCredentialOperation(env, { kind: "identity.create", identity });
      try {
        openOpenClawStateDatabase({ env });
        await closeOpenClawStateDatabaseAsync();
        {
          using local = openMigrationCredentials(env);
          const stored = readClientCredentialReceipt(local.database)!;
          // Older bootstraps persisted only a file binding, including after completion.
          stored.receipt.source = null;
          writeClientCredentialReceipt(local.database, stored.receipt, phase);
        }
        repairOpenClawStateDatabaseSchema({ env, versionMigrationOnly: true });
        expect(
          runClientCredentialOperation(env, { kind: "identity.read", identity_key: "primary" }),
        ).toEqual({ kind: "identity", identity });
        {
          using local = openMigrationCredentials(env);
          const stored = readClientCredentialReceipt(local.database)!;
          expect(stored).toMatchObject({
            phase: "complete",
            receipt: { source: { kind: "canonical", engine: "sqlite" } },
          });
          // An unproven older receipt must still reject replacement before enrichment.
          stored.receipt.source = null;
          writeClientCredentialReceipt(local.database, stored.receipt, phase);
        }

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
    },
  );

  it("migrates large credential stores without losing identities, tokens, or gateway scopes", async () => {
    // Each table exceeds SQLite's 32766-parameter limit when copied in one INSERT.
    const rowCount = 7_000;
    await using f = await fixture(false, rowCount);
    const snapshots = [
      "SELECT * FROM device_identities ORDER BY identity_key",
      "SELECT * FROM device_auth_tokens ORDER BY device_id, role",
      "SELECT * FROM gateway_origin_device_tokens ORDER BY gateway_scope, device_id, role",
    ].map((query) => ({ query, rows: f.source.prepare(query).all() }));
    f.migrate();
    using target = openMigrationCredentials(f.env);
    for (const snapshot of snapshots) {
      expect(snapshot.rows).toHaveLength(rowCount);
      expect(target.database.prepare(snapshot.query).all()).toEqual(snapshot.rows);
    }
    expect(readClientCredentialReceipt(target.database)?.phase).toBe("complete");
    expect(f.source.prepare("SELECT value FROM unaffected").get()).toEqual({ value: "preserve" });
    expect(
      f.source.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
    ).toBeUndefined();
    expect(
      target.database
        .prepare("SELECT socket_path,socket_token FROM native_exec_socket_credentials")
        .get(),
    ).toEqual({ socket_path: "/socket", socket_token: "socket-token" });
    const policy = f.source
      .prepare(
        "SELECT raw_json,socket_path,has_socket_token,updated_at_ms FROM exec_approvals_config",
      )
      .get()!;
    expect({ ...policy, raw_json: JSON.parse(String(policy.raw_json)) }).toEqual({
      raw_json: {
        version: 1,
        socket: { future: "keep" },
        defaults: { security: "deny" },
        agents: {},
      },
      socket_path: null,
      has_socket_token: 0,
      updated_at_ms: 55,
    });
  });

  it("leaves copied on source rollback and rebuilds an orphan without merging newer cached tokens", async () => {
    await using f = await fixture();
    const legacyPath = path.join(f.env.OPENCLAW_STATE_DIR, "identity", "node-device-auth.json");
    const {
      token: legacyToken,
      raw: legacyJson,
      legacyImport,
    } = createLegacyNodeAuthFixture(f.identity.deviceId);
    expect(() =>
      f.migrate(() => {
        throw new Error("interrupt before shared commit");
      }),
    ).toThrow("interrupt before shared commit");
    const target = openMigrationCredentials(f.env);
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
    f.migrate();
    const current = openMigrationCredentials(f.env);
    try {
      expect(current.database.prepare("SELECT token FROM device_auth_tokens").get()).toEqual({
        token: "token-original",
      });
      expect(importClientCredentialLegacy(current, legacyImport)).toBe(false);
      expect(
        importClientCredentialLegacy(current, {
          ...legacyImport,
          sha256: "b".repeat(64),
        }),
      ).toBe(false);
      expect(current.run({ kind: "token.read", key: legacyToken })).toEqual({
        kind: "token",
        token: null,
      });
      expect(fs.readFileSync(legacyPath, "utf8")).toBe(legacyJson);
    } finally {
      current.close();
    }
  });

  it("copies invalid canonical identity bytes exactly and keeps ordinary reads fail-closed", async () => {
    await using f = await fixture();
    const differentIdentity = generateStoredDeviceIdentity(21);
    f.source
      .prepare("UPDATE device_identities SET private_key_pem=?")
      .run(differentIdentity.privateKeyPem);
    const sourceRow = f.source.prepare("SELECT * FROM device_identities").get();
    f.migrate();
    {
      using local = openMigrationCredentials(f.env);
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
  });

  it("retains shared credentials and socket material when token scope validation fails", async () => {
    await using f = await fixture();
    f.source.prepare("UPDATE device_auth_tokens SET scopes_json='{}'").run();
    expect(() => f.migrate()).toThrow("invalid token record");
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
  });

  it.each([false, true])(
    "finishes interrupted publication after source retirement (deferred header=%s)",
    async (deferredHeader) => {
      await using f = await fixture();
      f.migrate();
      {
        using target = openMigrationCredentials(f.env);
        runSqliteImmediateTransactionSync(target.database, () =>
          target.database.prepare("UPDATE client_credential_migration SET phase='copied'").run(),
        );
      }
      f.source.exec(
        deferredHeader
          ? `CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT); INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','${CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION}');`
          : `UPDATE schema_meta SET schema_version=${CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION}; PRAGMA user_version=${CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION};`,
      );
      expect(f.source.prepare("PRAGMA user_version").get()).toEqual({
        user_version: deferredHeader ? 25 : CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
      });
      recoverClientCredentialStore(f.source, { path: f.sourcePath, env: f.env });
      using recovered = openMigrationCredentials(f.env);
      expect(readClientCredentialReceipt(recovered.database)?.phase).toBe("complete");
      expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(true);
    },
  );
});

it("checks the Swift receipt fixture against actual canonical migration output", async () => {
  await using f = await fixture(true);
  f.migrate();
  using target = openMigrationCredentials(f.env);
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
  runSqliteImmediateTransactionSync(fresh, () => {
    bindFreshClientCredentialStore(fresh, { path: freshPath, env: freshEnv });
    executeCanonicalStateSchema(fresh, { includeVersionLazyAdditiveTables: true });
    writeCurrentStateSchemaMetadata(fresh, 123);
  });
  using freshOwner = openMigrationCredentials(freshEnv);
  const freshStored = readClientCredentialReceipt(freshOwner.database)!;
  expect(freshStored.receipt.source?.identity).toBe(`${freshPath}:123`);
  freshStored.receipt.sharedFile = { path: "/fixture/state/openclaw.sqlite", dev: "1", ino: "2" };
  freshStored.receipt.source!.identity = "/fixture/state/openclaw.sqlite:123";
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
});

it("promotes an unchanged independent native source without losing refreshed local tokens or claims", async () => {
  const f = nativeFixture();
  const snapshot = readIndependentClientCredentialSource(f.sourcePath);
  seedIndependent(f, snapshot, { token: "refreshed-after-import", claimed: true });
  const maintenance = await captureClientCredentialMigrationFixture(f.sourcePath);
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
    using local = openMigrationCredentials(f.env);
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

it("rebuilds large changed native sources without reimporting revoked JSON credentials", async () => {
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
  seedIndependent(f, snapshot);
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
  const restoredTokens = Array.from({ length: 7_000 }, (_, index) => ({
    device_id: f.identity.deviceId,
    role: `restored-role-${String(index).padStart(4, "0")}`,
    token: `restored-token-${index}`,
    scopes_json: '[ "operator.read" ]',
    updated_at_ms: 20 + index,
  }));
  {
    using source = openNodeSqliteDatabase(f.sourcePath);
    runSqliteImmediateTransactionSync(source, () => {
      source.prepare("UPDATE device_identities SET updated_at_ms=9").run();
      source.exec(
        CLIENT_CREDENTIAL_SCHEMA_SQL.slice(
          CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE device_auth_tokens"),
          CLIENT_CREDENTIAL_SCHEMA_SQL.indexOf("CREATE TABLE gateway_origin_device_tokens"),
        ),
      );
      const insert = source.prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)");
      for (const token of restoredTokens) {
        insert.run(
          token.device_id,
          token.role,
          token.token,
          token.scopes_json,
          token.updated_at_ms,
        );
      }
    });
  }
  const restoredSnapshot = readIndependentClientCredentialSource(f.sourcePath);
  expect(restoredSnapshot.sha256).not.toBe(snapshot.sha256);
  expect(runClientCredentialOperation(f.env, { kind: "token.read", key })).toEqual({
    kind: "token",
    token: null,
  });
  {
    using local = openMigrationCredentials(f.env);
    expect(local.database.prepare("SELECT * FROM device_auth_tokens ORDER BY role").all()).toEqual(
      restoredTokens,
    );
    expect(readClientCredentialReceipt(local.database)).toMatchObject({
      phase: "complete",
      receipt: { source: { kind: "independent", sha256: restoredSnapshot.sha256 } },
    });
  }
  const maintenance = await captureClientCredentialMigrationFixture(f.sourcePath);
  try {
    upgradeNative(f, maintenance);
    expect((await importLegacy()).warnings).toEqual([]);
    expect(runClientCredentialOperation(f.env, { kind: "token.read", key })).toEqual({
      kind: "token",
      token: null,
    });
    using local = openMigrationCredentials(f.env);
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
  await using f = await fixture();
  // Minted by the v1 codec with the fixture's RFC 8032 private seed before storage cutover.
  const token =
    "v1.BwcHBwcHBwcHBwcHwqVwqlDFAwNPJ4TDoOKwRBzmmVH2zD4hlWSM9INXdYUuW35wvupzTDJq6OCFmLkD2varXqKRCJOHZq6zmCs_5a138mgvyTNU00swEQPLnTdZ5VEr2n-115k4EmS30yAm0EtylQ6rpbzjqNtSCCySwtnlYtDQrzcc-uV3cucEmEgsYpLSIf4qFVHiP0Ohc6JxVSv1xofWUQBR29jEQWdv9PyiJix1YE7n4vNCcEZA";
  f.migrate();
  await expect(resolvePublicSessionShareToken(token, { env: f.env })).resolves.toEqual({
    agentId: "synthetic",
    sessionKey: "agent:synthetic:public",
    sessionId: "migration-proof",
    shareId: "a".repeat(48),
  });
});
