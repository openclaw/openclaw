import "./port-command-worker.test-support.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorDatabasePort } from "../../commands/doctor-database-port.js";
import * as configIo from "../../config/io.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import {
  executeCanonicalStateSchema,
  writeCurrentStateSchemaMetadata,
} from "../../state/openclaw-state-db-maintenance.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareClientCredentialMigration } from "../client-credential-migration.js";
import { captureClientCredentialMigrationFixture } from "../client-credential-migration.test-support.js";
import * as credentials from "../client-credential-readiness.js";
import { readClientCredentialFileIdentity } from "../client-credential-receipt.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../client-credential-schema.js";
import {
  openClientCredentialCustody,
  runClientCredentialOperation,
} from "../client-credential-store.js";
import * as recovery from "../database-port-recovery.js";
import { generateStoredDeviceIdentity } from "../device-identity-material.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { connection, fixture } from "./port-command.integration.test-support.js";

afterEach(() => vi.restoreAllMocks());

async function seedMigratedCredentials(state: OpenClawTestState) {
  const shared = state.statePath("state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  const identity = generateStoredDeviceIdentity(12);
  {
    using source = openNodeSqliteDatabase(shared);
    source.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
    source
      .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
      .run("primary", identity.deviceId, identity.publicKeyPem, identity.privateKeyPem, 12, 12);
    source
      .prepare("INSERT INTO device_auth_tokens VALUES (?,?,?,?,?)")
      .run(identity.deviceId, "operator", "retained-token", '[ "operator.read" ]', 17);
    source
      .prepare("INSERT INTO gateway_origin_device_tokens VALUES (?,?,?,?,?,?)")
      .run(
        "https://gateway.example",
        identity.deviceId,
        "operator",
        "origin-token",
        '["operator.write"]',
        18,
      );
  }
  const maintenance = await captureClientCredentialMigrationFixture(shared);
  try {
    using source = openNodeSqliteDatabase(shared);
    maintenance.run(() =>
      runSqliteImmediateTransactionSync(source, () => {
        prepareClientCredentialMigration(source, {
          path: shared,
          env: state.env,
          fromVersion: 0,
          capture: maintenance.capture,
        });
        executeCanonicalStateSchema(source, { includeVersionLazyAdditiveTables: true });
        writeCurrentStateSchemaMetadata(source, 123);
      }),
    );
  } finally {
    await maintenance.close();
  }
  expectReady(state, identity.deviceId);
  return { shared, identity };
}

function snapshot(state: OpenClawTestState) {
  using owner = openClientCredentialCustody(state.env, { migration: true });
  assert(owner);
  const stored = credentials.readClientCredentialReceipt(owner.database);
  assert(stored?.receipt.source?.kind === "canonical");
  return {
    stored,
    local: readClientCredentialFileIdentity(owner.path),
    rows: [
      "device_identities",
      "device_auth_tokens",
      "gateway_origin_device_tokens",
      "native_exec_socket_credentials",
    ].map((table) => owner.database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()),
  };
}

function expectReady(state: OpenClawTestState, deviceId: string) {
  expect(
    runClientCredentialOperation(state.env, {
      kind: "identity.read",
      identity_key: "primary",
    }),
  ).toMatchObject({ kind: "identity", identity: { device_id: deviceId } });
  expect(
    runClientCredentialOperation(state.env, {
      kind: "token.read",
      key: { device_id: deviceId, role: "operator" },
    }),
  ).toMatchObject({ kind: "token", token: { token: "retained-token" } });
}

function expectBinding(
  state: OpenClawTestState,
  shared: string,
  original: ReturnType<typeof snapshot>,
  engine: "sqlite" | "postgres",
) {
  const after = snapshot(state);
  const anchor = readBackupEngine(shared);
  assert(engine === "sqlite" || anchor.engine === "postgres");
  expect(after).toEqual({
    ...original,
    stored: {
      ...original.stored,
      receipt: {
        ...original.stored.receipt,
        sharedFile: readClientCredentialFileIdentity(shared),
        source: {
          ...original.stored.receipt.source,
          engine,
          identity:
            anchor.engine === "postgres"
              ? anchor.storeId
              : original.stored.receipt.source!.identity,
        },
      },
    },
  });
}

describe.skipIf(!connection)("database port client credential continuity", () => {
  it("keeps migrated credentials ready through forward and reverse ports", async () => {
    await fixture(async ({ state }) => {
      const { shared, identity } = await seedMigratedCredentials(state);
      const original = snapshot(state);
      expectReady(state, identity.deviceId);
      await doctorDatabasePort({ to: "postgres" });
      expectReady(state, identity.deviceId);
      expectBinding(state, shared, original, "postgres");
      await doctorDatabasePort({ to: "sqlite" });
      expectReady(state, identity.deviceId);
      expectBinding(state, shared, original, "sqlite");
    }, true);
  }, 120_000);

  it("rebinds a reverse-port rollback to the retained PostgreSQL source", async () => {
    await fixture(async ({ state }) => {
      const { shared, identity } = await seedMigratedCredentials(state);
      const original = snapshot(state);
      await doctorDatabasePort({ to: "postgres" });
      const write = configIo.writeConfigFile;
      vi.spyOn(configIo, "writeConfigFile").mockImplementationOnce(async (...args) => {
        await write(...args);
        throw new Error("interrupt reverse port before completion");
      });
      await expect(doctorDatabasePort({ to: "sqlite" })).rejects.toThrow("switch config");
      vi.restoreAllMocks();
      await doctorDatabasePort({ rollback: recovery.databasePortManifestPath(state.stateDir) });
      expectReady(state, identity.deviceId);
      expectBinding(state, shared, original, "postgres");
    }, true);
  }, 120_000);

  it.each(["receipt", "archive"])(
    "resumes completed publication after a %s failure",
    async (failure) => {
      await fixture(async ({ state }) => {
        const { shared, identity } = await seedMigratedCredentials(state);
        const original = snapshot(state);
        if (failure === "receipt") {
          vi.spyOn(credentials, "writeClientCredentialReceipt").mockImplementationOnce(() => {
            throw new Error("interrupt credential receipt");
          });
        } else {
          vi.spyOn(recovery, "archiveDatabasePortManifest").mockImplementationOnce(() => {
            throw new Error("interrupt archive");
          });
        }
        await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("finalize/archive");
        vi.restoreAllMocks();
        const manifestPath = recovery.databasePortManifestPath(state.stateDir);
        expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).state).toBe("complete");
        await expect(doctorDatabasePort({ rollback: manifestPath })).rejects.toThrow(
          "Database port",
        );
        await doctorDatabasePort({ resume: manifestPath });
        expectReady(state, identity.deviceId);
        expectBinding(state, shared, original, "postgres");
      }, true);
    },
    120_000,
  );

  it("refuses mismatched file, canonical identity, and independent receipts before publication", async () => {
    await fixture(async ({ state }) => {
      const { shared } = await seedMigratedCredentials(state);
      const original = snapshot(state);
      const hash = () => createHash("sha256").update(fs.readFileSync(shared)).digest("hex");
      const before = hash();
      for (const mismatch of ["file", "identity", "independent"]) {
        using owner = openClientCredentialCustody(state.env, { migration: true });
        assert(owner);
        const changed = structuredClone(original.stored.receipt);
        assert(changed.sharedFile && changed.source);
        if (mismatch === "file") {
          changed.sharedFile.ino = `${changed.sharedFile.ino}0`;
        } else if (mismatch === "identity") {
          changed.source.identity += ":unrelated";
        } else {
          changed.source.kind = "independent";
          changed.source.engine = "native-v0";
        }
        owner.transaction(() =>
          credentials.writeClientCredentialReceipt(owner.database, changed, "complete"),
        );
        owner.close();
        await expect(doctorDatabasePort({ to: "postgres" })).rejects.toThrow("Database port");
        expect(hash()).toBe(before);
        expect(readBackupEngine(shared)).toEqual({ engine: "sqlite" });
      }
    }, true);
  }, 120_000);
});
