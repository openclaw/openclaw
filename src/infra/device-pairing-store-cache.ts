import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DevicePairingStoreState } from "./device-pairing.types.js";
import type { EngineConnection } from "./sql-connection.js";
import { readSqliteDatabaseWriteRevision } from "./sqlite-database-admission.js";
import { runSqliteReadSnapshotSync } from "./sqlite-transaction.js";

type DevicePairingStoreCache = {
  connection: EngineConnection;
  path: string;
  state: DevicePairingStoreState;
  writeRevision: number;
  revision: string;
  deviceId?: string;
};

// Writer settlement invalidates snapshots across connections and worker isolates.
const cache = resolveGlobalSingleton<{ value: DevicePairingStoreCache | undefined }>(
  Symbol.for("openclaw.devicePairingStoreCache"),
  () => ({ value: undefined }),
);

export function invalidateDevicePairingStoreCache(database: {
  db: EngineConnection;
  path: string;
}): void {
  if (cache.value?.connection === database.db && cache.value.path === database.path) {
    cache.value = undefined;
  }
}

/** Borrowed worker facts; projections must not mutate this revision's cached rows. */
export function readCachedDevicePairingStoreSnapshot(
  db: EngineConnection,
  path: string,
  read: () => Pick<DevicePairingStoreCache, "state" | "revision">,
  deviceId?: string,
): Pick<DevicePairingStoreCache, "state" | "revision"> {
  if (db.isTransaction) {
    return read();
  }
  const writeRevision = readSqliteDatabaseWriteRevision(db);
  const cached = cache.value;
  if (
    writeRevision !== undefined &&
    cached?.connection === db &&
    cached.path === path &&
    cached.writeRevision === writeRevision &&
    (cached.deviceId === undefined || cached.deviceId === deviceId)
  ) {
    return cached;
  }
  const snapshot =
    deviceId === undefined
      ? runSqliteReadSnapshotSync(db, read, {
          operationLabel: "devicePairing.snapshot",
        })
      : read();
  if (writeRevision !== undefined) {
    // A commit during the read retires this captured revision on the next lookup.
    cache.value = { connection: db, path, ...snapshot, writeRevision, deviceId };
  }
  return snapshot;
}
