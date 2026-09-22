import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  readDeviceAuthTokenObservationFromDatabase,
  readOriginDeviceTokenObservationFromDatabase,
  storeDeviceAuthTokenInDatabase,
  storeOriginDeviceTokenInDatabase,
} from "./device-auth-store.kernel.js";

type Lookup = { deviceId: string; role: string; env?: NodeJS.ProcessEnv };
type OriginLookup = Lookup & { gatewayScope: string };
type Seed = Parameters<typeof storeDeviceAuthTokenInDatabase>[1] & { env?: NodeJS.ProcessEnv };

// Fixture acquisition bypasses runtime policy; owner tests exercise the real facade.
export function readDeviceAuthTokenForTest(params: Lookup) {
  return readDeviceAuthTokenObservationFromDatabase(
    openOpenClawStateDatabase({ env: params.env }).db,
    params,
  ).entry;
}

export function readOriginDeviceTokenReadOnlyForTest(params: OriginLookup) {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readOriginDeviceTokenObservationFromDatabase(db, params).entry,
      { env: params.env },
    ) ?? null
  );
}

export function seedDeviceAuthToken(params: Seed) {
  const input = { ...params, updatedAtMs: params.updatedAtMs ?? Date.now() };
  return runOpenClawStateWriteTransaction(({ db }) => storeDeviceAuthTokenInDatabase(db, input), {
    env: params.env,
  });
}

export function seedOriginDeviceToken(params: Seed & { gatewayScope: string }) {
  const input = { ...params, updatedAtMs: params.updatedAtMs ?? Date.now() };
  return runOpenClawStateWriteTransaction(({ db }) => storeOriginDeviceTokenInDatabase(db, input), {
    env: params.env,
  });
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
