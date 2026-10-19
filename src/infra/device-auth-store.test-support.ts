import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
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
  const holder = holdStateDatabaseWriteTransaction(databasePath, 10_000);
  await holder.ready;
  return async () => {
    holder.release();
    await holder.joined;
  };
}
