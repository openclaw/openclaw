import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { drainAgentDatabaseResources } from "../state/openclaw-agent-db-resources.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { runClientCredentialOperationAsync } from "./client-credential-async.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "./device-identity-material.js";

const execFileAsync = promisify(execFile);
const dirs = createTempDirTracker();
const identity = storedDeviceIdentityToRow("primary", generateStoredDeviceIdentity(123), 456);

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  dirs.cleanup();
});

type FileKey = { dev: string; ino: string; birthtime: string; version: number };
type OtherClientResult = { before: FileKey; after: FileKey; deviceId?: string };

async function otherClient(
  databasePath: string,
  operation: "read" | "copied" | "newer" | "newer-layout" | "replace" | "damage",
): Promise<OtherClientResult> {
  const { stdout } = await execFileAsync(
    resolveTestNodeExecPath(),
    [
      "--input-type=module",
      "-e",
      `
        import fs from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        const [pathname, operation] = process.argv.slice(1);
        const key = () => {
          const stat = fs.statSync(pathname, { bigint: true });
          const db = new DatabaseSync(pathname, { timeout: 0 });
          try {
            return {
              dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs),
              version: db.prepare("PRAGMA user_version").get().user_version,
            };
          } finally { db.close(); }
        };
        const before = key();
        let deviceId;
        if (operation === "replace") {
          const replacement = pathname + ".replacement";
          fs.copyFileSync(pathname, replacement);
          const db = new DatabaseSync(replacement, { timeout: 0 });
          db.exec("DROP TABLE device_auth_tokens");
          db.close();
          const owner = new DatabaseSync(pathname, { timeout: 0 });
          owner.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
          owner.close();
          fs.renameSync(replacement, pathname);
        } else {
          const db = new DatabaseSync(pathname, { timeout: 0 });
          try {
            db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
            if (operation === "copied") {
              db.exec("UPDATE client_credential_migration SET phase = 'copied' WHERE version = 1");
            } else if (operation === "newer" || operation === "newer-layout") {
              db.exec("PRAGMA user_version = 2");
              if (operation === "newer-layout") {
                db.exec("ALTER TABLE client_credential_migration RENAME TO future_migration_receipt");
              } else {
                db.exec("UPDATE client_credential_migration SET source_store = 'future receipt format'");
              }
            } else if (operation === "damage") {
              db.exec("DROP TABLE device_auth_tokens");
            } else {
              deviceId = db.prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'").get().device_id;
            }
            db.exec("COMMIT");
          } finally { db.close(); }
        }
        process.stdout.write(JSON.stringify({ before, after: key(), deviceId }));
      `,
      databasePath,
      operation,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout) as OtherClientResult;
}

async function fixture() {
  const root = dirs.make("client-credential-lifecycle-");
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  await runClientCredentialOperationAsync(env, { kind: "identity.create", identity });
  const read = () =>
    runClientCredentialOperationAsync(env, { kind: "identity.read", identity_key: "primary" });
  expect(await read()).toEqual({ kind: "identity", identity });
  return { read, databasePath: resolveClientCredentialStorePath(env) };
}

it("releases physical custody so another process can read between cached operations", async () => {
  const { read, databasePath } = await fixture();
  const observed = await otherClient(databasePath, "read");
  expect(observed.deviceId).toBe(identity.device_id);
  expect(observed.after).toEqual(observed.before);
  expect(await read()).toEqual({ kind: "identity", identity });
});

it("refuses an in-place copied receipt from another process despite an unchanged admission key", async () => {
  const { read, databasePath } = await fixture();
  const observed = await otherClient(databasePath, "copied");
  expect(observed.after).toEqual(observed.before);
  await expect(read()).rejects.toThrow("migration is incomplete or stale");
});

it.each(["newer", "newer-layout"] as const)(
  "refuses a %s schema before interpreting its changed receipt",
  async (operation) => {
    const { read, databasePath } = await fixture();
    const observed = await otherClient(databasePath, operation);
    expect(observed.before.version).toBe(1);
    expect(observed.after).toEqual({ ...observed.before, version: 2 });
    await expect(read()).rejects.toThrow("unsupported schema version 2");
  },
);

it("re-admits a replacement file before serving a row that remains readable", async () => {
  const { read, databasePath } = await fixture();
  const observed = await otherClient(databasePath, "replace");
  expect(observed.after.ino).not.toBe(observed.before.ino);
  expect(observed.after.version).toBe(observed.before.version);
  await expect(read()).rejects.toThrow("missing table device_auth_tokens");
});

it("discards schema admission facts when maintenance drainage closes the worker", async () => {
  const { read, databasePath } = await fixture();
  // Inject foreign same-version corruption only to prove drainage forces full schema admission.
  // The selected identity row stays readable, so serving it would miss this damaged schema.
  const observed = await otherClient(databasePath, "damage");
  expect(observed.after).toEqual(observed.before);
  await drainAgentDatabaseResources({ path: databasePath }, async () => {});
  await expect(read()).rejects.toThrow("missing table device_auth_tokens");
});
