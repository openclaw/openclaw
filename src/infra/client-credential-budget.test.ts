import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runClientCredentialOperationAsync } from "./client-credential-async.js";
import { writeClientCredentialReceipt } from "./client-credential-readiness.js";
import { emptyClientCredentialReceipt } from "./client-credential-receipt.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const statementKinds: [RegExp, string][] = [
  [/^pragma journal_mode$/, "journal"],
  [/^pragma locking_mode=exclusive$/, "custody"],
  [/^(begin|commit|rollback)\b/, "transaction"],
  [/pragma_user_version/, "receiptAndVersion"],
  [/^pragma user_version$/, "coldVersion"],
  [/^pragma schema_version$/, "schemaVersion"],
  [/pragma (integrity_check|foreign_key_check)/, "integrity"],
  [/^select \* from "device_identities"/, "identityRead"],
  [/^insert into "device_identities"/, "identityInsert"],
  [/^insert into "client_credential_migration"/, "receiptWrite"],
  [/^select \* from "client_credential_migration"/, "receiptRead"],
  [/sqlite_schema|pragma table_list|pragma_table|pragma_index|pragma_foreign_key/, "catalog"],
];

it("admits the six-call census identity workload once and bounds its database work", async () => {
  const root = dirs.make("credential-budget-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  {
    using seed = openClientCredentialCustody(env, { createIfMissing: true, migration: true })!;
    writeClientCredentialReceipt(seed.database, emptyClientCredentialReceipt(), "complete");
  }
  const statements = path.join(root, "statements.jsonl");
  const preload = path.join(root, "trace.cjs");
  // Observe native execution in the real worker; never capture bindings or credential contents.
  fs.writeFileSync(
    preload,
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const record = (db, sql) => {
      if (db.location()?.endsWith(path.join('client', 'credentials.sqlite'))) {
        fs.appendFileSync(process.env.CREDENTIAL_SQL_TRACE, JSON.stringify(sql) + '\\n');
      }
    };
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      record(this, sql);
      return Reflect.apply(exec, this, arguments);
    };
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const db = this;
      const statement = Reflect.apply(prepare, db, arguments);
      for (const method of ['get', 'all', 'run', 'iterate']) {
        const original = statement[method];
        statement[method] = function() {
          record(db, sql);
          return Reflect.apply(original, this, arguments);
        };
      }
      return statement;
    };
  `,
  );
  const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(123), 456);
  const read = { kind: "identity.read", identity_key: "node" } as const;
  const create = { kind: "identity.create", identity } as const;
  try {
    await withEnvAsync(
      { ...env, ...sqliteWorkerPreloadEnv(preload), CREDENTIAL_SQL_TRACE: statements },
      async () => {
        for (const operation of [read, create, create, read, create, create]) {
          const result = await runClientCredentialOperationAsync(env, operation);
          expect(result).toEqual({
            kind: "identity",
            identity: operation === read ? null : identity,
          });
        }
        await drainGlobalSingletonLifecycleState();
      },
    );
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
  const counts: Record<string, number> = {};
  for (const line of fs.readFileSync(statements, "utf8").trim().split("\n")) {
    const sql = String(JSON.parse(line)).trim().toLowerCase();
    const kind = statementKinds.find(([pattern]) => pattern.test(sql))?.[1] ?? "unexpected";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  expect.soft(counts).toEqual({
    journal: 6,
    custody: 6,
    transaction: 12,
    receiptAndVersion: 6,
    coldVersion: 1,
    schemaVersion: 1,
    integrity: 2,
    catalog: 5,
    identityRead: 6,
    identityInsert: 1,
    receiptWrite: 1,
  });
});
