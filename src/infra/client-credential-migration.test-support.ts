import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { prepareClientCredentialMigration } from "./client-credential-migration.js";
import { CLIENT_CREDENTIAL_SCHEMA_SQL } from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export function openMigrationCredentials(env: NodeJS.ProcessEnv, createIfMissing = false) {
  return openClientCredentialCustody(env, { createIfMissing, migration: true })!;
}

export async function captureClientCredentialMigrationFixture(sourcePath: string) {
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

export async function createClientCredentialMigrationFixture(
  root: string,
  customKeys = false,
  credentialRowCount = 1,
) {
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
  if (credentialRowCount > 1) {
    const insertIdentity = source.prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)");
    const insertToken = source.prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)");
    const insertOrigin = source.prepare(
      "INSERT INTO gateway_origin_device_tokens VALUES (?,?,?,?,?,?)",
    );
    runSqliteImmediateTransactionSync(source, () => {
      for (let index = 1; index < credentialRowCount; index++) {
        insertIdentity.run(
          `profile-${index}`,
          identity.deviceId,
          identity.publicKeyPem,
          identity.privateKeyPem,
          identity.createdAtMs,
          99 + index,
        );
        insertToken.run(
          identity.deviceId,
          `v2.gateway.operator.${index}`,
          `token-${index}`,
          '[ "operator.read", "operator.write" ]',
          101 + index,
        );
        insertOrigin.run(
          `https://gateway-${index}.example`,
          identity.deviceId,
          "operator",
          `origin-token-${index}`,
          '[ "operator.write" ]',
          102 + index,
        );
      }
    });
  }
  const maintenance = await captureClientCredentialMigrationFixture(sourcePath);
  return {
    source,
    sourcePath,
    env,
    identity,
    maintenance,
    migrate(afterCopy?: () => void) {
      maintenance.run(() =>
        runSqliteImmediateTransactionSync(source, () => {
          prepareClientCredentialMigration(source, {
            path: sourcePath,
            env,
            fromVersion: 25,
            capture: maintenance.capture,
          });
          afterCopy?.();
        }),
      );
    },
    async [Symbol.asyncDispose]() {
      source.close();
      await maintenance.close();
    },
  };
}
