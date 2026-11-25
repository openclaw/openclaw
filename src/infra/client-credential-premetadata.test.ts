import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { repairOpenClawStateDatabaseSchema } from "../state/openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "../state/openclaw-state-schema.test-support.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { readClientCredentialReceipt } from "./client-credential-readiness.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { generateStoredDeviceIdentity } from "./device-identity-material.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { writeLegacyStateSchemaV1 } from "./state-migrations.caller-mode.test-helpers.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("recovers pre-metadata v1 credentials after shared commit interrupts local completion", async () => {
  const stateDir = dirs.make("client-premetadata-migration-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sourcePath = path.join(stateDir, "state", "openclaw.sqlite");
  writeLegacyStateSchemaV1(sourcePath);
  const identity = generateStoredDeviceIdentity(7);
  {
    using source = openNodeSqliteDatabase(sourcePath);
    addPreCutoverClientCredentialTablesForTest(source);
    source
      .prepare("INSERT INTO device_identities VALUES (?,?,?,?,?,?)")
      .run("primary", identity.deviceId, identity.publicKeyPem, identity.privateKeyPem, 7, 8);
  }
  const prototype = requireNodeSqlite().StatementSync.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its native statement receiver.
  const originalRun = prototype.run;
  let interruptedCompletions = 0;
  const completion = vi.spyOn(prototype, "run").mockImplementation(
    new Proxy(originalRun, {
      apply(run, statement: StatementSync, args) {
        if (
          statement.sourceSQL.startsWith('insert into "client_credential_migration"') &&
          args.includes("complete")
        ) {
          interruptedCompletions += 1;
          throw new Error("fixture completion interrupted");
        }
        return Reflect.apply(run, statement, args);
      },
    }),
  );
  try {
    const result = await withStateMigrationBackupForTest({ env }, () =>
      repairOpenClawStateDatabaseSchema({ env }),
    );
    expect(result.warnings).toEqual([]);
  } finally {
    completion.mockRestore();
  }
  expect(interruptedCompletions).toBe(1);
  const localPath = resolveClientCredentialStorePath(env);
  expect(fs.existsSync(localPath)).toBe(true);
  {
    using source = openNodeSqliteDatabase(sourcePath, { readOnly: true });
    expect(source.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      source.prepare("SELECT name FROM sqlite_schema WHERE name='device_identities'").get(),
    ).toBeUndefined();
    const createdAt = source
      .prepare("SELECT created_at FROM schema_meta WHERE meta_key='primary'")
      .get()?.created_at;
    using local = openClientCredentialCustody(env, { migration: true })!;
    expect(readClientCredentialReceipt(local.database)).toMatchObject({
      phase: "copied",
      receipt: { source: { engine: "sqlite", identity: `${sourcePath}:${String(createdAt)}` } },
    });
  }
  const recovered = await withStateMigrationBackupForTest({ env }, () =>
    repairOpenClawStateDatabaseSchema({ env }),
  );
  expect(recovered.warnings).toEqual([]);
  using local = openClientCredentialCustody(env, { migration: true })!;
  expect(readClientCredentialReceipt(local.database)?.phase).toBe("complete");
  expect(local.database.prepare("SELECT private_key_pem FROM device_identities").get()).toEqual({
    private_key_pem: identity.privateKeyPem,
  });
});
