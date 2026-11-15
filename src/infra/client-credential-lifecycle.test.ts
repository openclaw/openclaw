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
  operation: "read" | "copied" | "newer-layout" | "replace" | "damage",
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
        const withDatabase = (file, run) => {
          const db = new DatabaseSync(file, { timeout: 0 });
          try { return run(db); } finally { db.close(); }
        };
        const key = () => {
          const stat = fs.statSync(pathname, { bigint: true });
          return withDatabase(pathname, db => ({
            dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs),
            version: db.prepare("PRAGMA user_version").get().user_version,
          }));
        };
        const before = key();
        let deviceId;
        if (operation === "replace") {
          const replacement = pathname + ".replacement";
          fs.copyFileSync(pathname, replacement);
          withDatabase(replacement, db => db.exec("DROP TABLE device_auth_tokens"));
          withDatabase(pathname, db => db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT"));
          fs.renameSync(replacement, pathname);
        } else {
          withDatabase(pathname, db => {
            db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
            if (operation === "copied") {
              db.exec("UPDATE client_credential_migration SET phase = 'copied' WHERE version = 1");
            } else if (operation === "newer-layout") {
              db.exec("PRAGMA user_version = 2; ALTER TABLE client_credential_migration RENAME TO future_migration_receipt");
            } else if (operation === "damage") {
              db.exec("DROP TABLE device_auth_tokens");
            } else {
              deviceId = db.prepare("SELECT device_id FROM device_identities WHERE identity_key = 'primary'").get().device_id;
            }
            db.exec("COMMIT");
          });
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

it.each([
  ["read", undefined],
  ["copied", "migration is incomplete or stale"],
  ["newer-layout", "unsupported schema version 2"],
  ["replace", "missing table device_auth_tokens"],
  ["damage", "missing table device_auth_tokens"],
] as const)("revalidates custody and schema after another client: %s", async (operation, error) => {
  const { read, databasePath } = await fixture();
  const observed = await otherClient(databasePath, operation);
  if (operation === "newer-layout") {
    expect(observed.before.version).toBe(1);
    expect(observed.after).toEqual({ ...observed.before, version: 2 });
  } else if (operation === "replace") {
    expect(observed.after.ino).not.toBe(observed.before.ino);
    expect(observed.after.version).toBe(observed.before.version);
  } else {
    expect(observed.after).toEqual(observed.before);
  }
  if (operation === "damage") {
    // The identity remains readable; drainage must force full schema admission.
    await drainAgentDatabaseResources({ path: databasePath }, async () => {});
  }
  if (error) {
    await expect(read()).rejects.toThrow(error);
  } else {
    expect(observed.deviceId).toBe(identity.device_id);
    expect(await read()).toEqual({ kind: "identity", identity });
  }
});
