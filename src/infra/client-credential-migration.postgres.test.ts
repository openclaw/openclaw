import "../test-utils/prepare-compiled-subprocesses.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePostgresBackup } from "../snapshot/database-backup.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db-contract.js";
import { admitStatePostgres, stateEngineSchema } from "../state/openclaw-state-db-engine.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../state/openclaw-state-maintenance-context.js";
import { advanceStateSchemaContentVersion } from "../state/openclaw-state-schema-publication.js";
import {
  prepareClientCredentialMigration,
  recoverClientCredentialStore,
} from "./client-credential-migration.js";
import { openMigrationCredentials } from "./client-credential-migration.test-support.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { readClientCredentialReceipt } from "./client-credential-readiness.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { openEngineStore } from "./database-engine/open.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { isPostgresSqlConnection } from "./sql-connection.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterAll);
const namespaces = new Set<string>();
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

async function fixture() {
  const root = directories.make("client-pg-migration-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const pathname = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const anchor = openNodeSqliteDatabase(pathname);
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess(databasePath) {
      expect(databasePath).toBe(pathname);
    },
  });
  let capturedGeneration: string | undefined = undefined;
  let cutoverContentVersionTimestamp: string | undefined;
  const open = (migrate: boolean, interrupt = false) =>
    maintenance.run(() =>
      withEngineStoreAdmission(() => {
        const db = openEngineStore({
          anchor,
          schema: migrate
            ? stateEngineSchema
            : {
                id: "state",
                version: 26,
                sqlite: "",
                ...stateEngineSchema.postgresMigrations!.find((step) => step.version === 27)!
                  .fromSchema,
              },
          input: {
            connection: connection!,
            schemaPrefix: "credential_proof",
          },
          inspectSqlite: () => ({ hasExistingData: false, hasEngineAnchor: false }),
          prepareAnchor() {},
          openSqlite() {
            throw new Error("Expected PostgreSQL");
          },
          admitPostgres(database, fresh) {
            if (migrate) {
              admitStatePostgres(database, fresh);
            }
          },
          beforeMigrate(source, fromVersion) {
            if (fromVersion === CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1) {
              cutoverContentVersionTimestamp = String(
                source
                  .prepare(
                    "SELECT updated_at_ms FROM config_machine_state WHERE state_key='state.schema.contentVersion'",
                  )
                  .get()?.updated_at_ms,
              );
            }
            prepareClientCredentialMigration(source, {
              path: pathname,
              env,
              fromVersion,
              capture: capturedGeneration
                ? {
                    path: pathname,
                    generation: capturedGeneration,
                    assertCurrent: maintenance.assertAdmission,
                  }
                : undefined,
            });
            advanceStateSchemaContentVersion(source, {
              fromVersion,
              toVersion: stateEngineSchema.version,
            });
            if (interrupt && fromVersion === CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1) {
              throw new Error("Interrupted after local copy before source commit");
            }
          },
        });
        if (!isPostgresSqlConnection(db)) {
          throw new Error("Expected PostgreSQL credential fixture");
        }
        return db;
      }),
    );
  const source = open(false);
  const namespace = getPostgresPhysicalFacts(source)!.namespace;
  namespaces.add(namespace);
  const identity = generateStoredDeviceIdentity(12);
  withEngineStoreAdmission(() =>
    source.runTransaction(() => {
      source
        .prepare("INSERT INTO schema_meta VALUES ('primary','global',26,NULL,'fixture',123,123)")
        .run();
      source
        .prepare(
          "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion','26',1),('unaffected','original',1)",
        )
        .run();
      source
        .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
        .run("primary", identity.deviceId, identity.publicKeyPem, identity.privateKeyPem, 12, 99);
      source
        .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
        .run(
          identity.deviceId,
          "v2.gateway.operator",
          "retained-token",
          '[ "operator.read" ]',
          101,
        );
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
      source.prepare("INSERT INTO exec_approvals_config VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
        "current",
        JSON.stringify({
          version: 1,
          socket: { path: "/synthetic.sock", token: "socket-secret", future: "keep" },
          defaults: { security: "deny" },
          agents: {},
        }),
        "/synthetic.sock",
        1,
        "deny",
        null,
        null,
        null,
        0,
        0,
        55,
      );
    }),
  );
  source.close();
  const captured = await capturePostgresBackup({
    sourcePath: pathname,
    directory: path.join(root, "captured"),
    profile: "exact",
    config: { database: { engine: "postgres", postgres: { connection: connection! } } },
    assertCurrent: maintenance.assertAdmission,
  });
  // Direct owner-contract proof uses the captured exact snapshot, not Doctor attribution.
  capturedGeneration = createHash("sha256")
    .update(stableStringify({ source: captured.source, verification: captured.verification }))
    .digest("hex");
  maintenance.run(() => admitOpenClawMaintenanceLiveAuthorityReads(pathname));
  const client = new Client({ connectionString: connection });
  await client.connect();
  await client.query(`SET search_path = "${namespace}"`);
  return {
    env,
    pathname,
    identity,
    client,
    open,
    get cutoverContentVersionTimestamp() {
      return cutoverContentVersionTimestamp;
    },
    async [Symbol.asyncDispose]() {
      await maintenance.close();
      anchor.close();
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      namespaces.delete(namespace);
      await client.end();
    },
  };
}

describe.skipIf(!connection)(
  "PostgreSQL client credential cutover under fixture-owned capture",
  () => {
    it("preserves exact bytes and policy while retiring the verified server rows", async () => {
      await using f = await fixture();
      const migrated = f.open(true);
      try {
        {
          using local = openMigrationCredentials(f.env);
          expect(local.database.prepare("SELECT * FROM device_identities").get()).toEqual({
            identity_key: "primary",
            device_id: f.identity.deviceId,
            public_key_pem: f.identity.publicKeyPem,
            private_key_pem: f.identity.privateKeyPem,
            created_at_ms: 12,
            updated_at_ms: 99,
          });
          expect(
            local.database.prepare("SELECT token,scopes_json FROM device_auth_tokens").get(),
          ).toEqual({ token: "retained-token", scopes_json: '[ "operator.read" ]' });
          expect(
            local.database.prepare("SELECT token FROM gateway_origin_device_tokens").get(),
          ).toEqual({ token: "origin-token" });
          expect(
            local.database
              .prepare("SELECT socket_path,socket_token FROM native_exec_socket_credentials")
              .get(),
          ).toEqual({ socket_path: "/synthetic.sock", socket_token: "socket-secret" });
          expect(readClientCredentialReceipt(local.database)).toMatchObject({
            phase: "complete",
            receipt: { source: { kind: "canonical", engine: "postgres", destinationVersion: 1 } },
          });
        }
        const row = (
          await f.client.query(
            "SELECT raw_json,socket_path,has_socket_token,updated_at_ms FROM exec_approvals_config",
          )
        ).rows[0];
        expect(JSON.parse(row.raw_json)).toEqual({
          version: 1,
          socket: { future: "keep" },
          defaults: { security: "deny" },
          agents: {},
        });
        expect(row).toMatchObject({
          socket_path: null,
          has_socket_token: "0",
          updated_at_ms: "55",
        });
        for (const name of [
          "device_identities",
          "device_auth_tokens",
          "gateway_origin_device_tokens",
        ]) {
          expect(
            (await f.client.query("SELECT to_regclass($1) AS relation", [name])).rows[0].relation,
          ).toBeNull();
        }
        expect(
          (
            await f.client.query(
              "SELECT value_json FROM config_machine_state WHERE state_key='unaffected'",
            )
          ).rows,
        ).toEqual([{ value_json: "original" }]);
        expect(
          (
            await f.client.query(
              "SELECT value_json,updated_at_ms FROM config_machine_state WHERE state_key='state.schema.contentVersion'",
            )
          ).rows,
        ).toEqual([
          {
            value_json: String(OPENCLAW_STATE_SCHEMA_VERSION),
            updated_at_ms: f.cutoverContentVersionTimestamp,
          },
        ]);
      } finally {
        migrated.close();
      }
    });

    it("retains source authority across interruption and rebuilds a completed orphan without merging", async () => {
      await using f = await fixture();
      expect(() => f.open(true, true)).toThrow("Interrupted after local copy");
      expect((await f.client.query("SELECT token FROM device_auth_tokens")).rows).toEqual([
        { token: "retained-token" },
      ]);
      {
        using local = openMigrationCredentials(f.env);
        expect(readClientCredentialReceipt(local.database)?.phase).toBe("copied");
        runSqliteImmediateTransactionSync(local.database, () => {
          local.database.prepare("UPDATE device_auth_tokens SET token='orphan-token'").run();
          local.database
            .prepare(
              "INSERT INTO device_auth_tokens VALUES ('orphan-device','node','orphan-only','[]',999)",
            )
            .run();
          local.database.prepare("UPDATE client_credential_migration SET phase='complete'").run();
        });
      }
      const migrated = f.open(true);
      migrated.close();
      {
        using current = openMigrationCredentials(f.env);
        expect(current.database.prepare("SELECT token FROM device_auth_tokens").all()).toEqual([
          { token: "retained-token" },
        ]);
        expect(readClientCredentialReceipt(current.database)?.phase).toBe("complete");
      }
    });

    it("does not retire invalid credentials and resumes interrupted completion only after source commit", async () => {
      await using f = await fixture();
      await f.client.query("UPDATE device_auth_tokens SET scopes_json='{}'");
      expect(() => f.open(true)).toThrow("invalid token record");
      expect(fs.existsSync(resolveClientCredentialStorePath(f.env))).toBe(false);
      expect((await f.client.query("SELECT token FROM device_auth_tokens")).rows).toEqual([
        { token: "retained-token" },
      ]);
      await f.client.query("UPDATE device_auth_tokens SET scopes_json='[ \"operator.read\" ]'");
      const migrated = f.open(true);
      try {
        {
          using local = openMigrationCredentials(f.env);
          runSqliteImmediateTransactionSync(local.database, () =>
            local.database.prepare("UPDATE client_credential_migration SET phase='copied'").run(),
          );
        }
        withEngineStoreAdmission(() =>
          recoverClientCredentialStore(migrated, { path: f.pathname, env: f.env }),
        );
        {
          using recovered = openMigrationCredentials(f.env);
          expect(readClientCredentialReceipt(recovered.database)?.phase).toBe("complete");
        }
      } finally {
        migrated.close();
      }
    });
  },
);
