import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { runClientCredentialOperation } from "./client-credential-store.js";
import { createDeviceAuthEntry, deviceAuthEntryFromRow } from "./device-auth-store.kernel.js";

type Lookup = { deviceId: string; role: string; env?: NodeJS.ProcessEnv };
type OriginLookup = Lookup & { gatewayScope: string };
type Seed = Lookup & { token: string; scopes?: string[]; updatedAtMs?: number };

export function readDeviceAuthTokenForTest(params: Lookup) {
  const result = runClientCredentialOperation(params.env ?? process.env, {
    kind: "token.read",
    key: { device_id: params.deviceId, role: params.role },
  });
  return result.kind === "token" && result.token ? deviceAuthEntryFromRow(result.token) : null;
}

export function readOriginDeviceTokenReadOnlyForTest(params: OriginLookup) {
  const result = runClientCredentialOperation(params.env ?? process.env, {
    kind: "token.read",
    key: { device_id: params.deviceId, role: params.role, gateway_scope: params.gatewayScope },
  });
  return result.kind === "token" && result.token ? deviceAuthEntryFromRow(result.token) : null;
}

function seed(params: Seed & { gatewayScope?: string }) {
  const entry = createDeviceAuthEntry(params);
  runClientCredentialOperation(params.env ?? process.env, {
    kind: "token.replace",
    key: {
      device_id: params.deviceId,
      role: entry.role,
      ...(params.gatewayScope === undefined ? {} : { gateway_scope: params.gatewayScope }),
    },
    token: {
      device_id: params.deviceId,
      role: entry.role,
      token: entry.token,
      scopes_json: JSON.stringify(entry.scopes),
      updated_at_ms: entry.updatedAtMs,
    },
  });
  return entry;
}
export function seedDeviceAuthToken(params: Seed) {
  return seed(params);
}
export function seedOriginDeviceToken(params: Seed & { gatewayScope: string }) {
  return seed(params);
}

/** Hold a synthetic native writer while the host proves its asynchronous admission. */
export async function holdDeviceAuthWriterForTest(databasePath: string) {
  const release = new Int32Array(new SharedArrayBuffer(4));
  const writer = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    db.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    Atomics.wait(workerData.release, 0, 0, 10000);
    db.exec("ROLLBACK");
    db.close();
  `,
    { eval: true, workerData: { path: databasePath, release } },
  );
  const exited = once(writer, "exit");
  await once(writer, "message");
  return async () => {
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
    await exited;
  };
}
