import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DevicePairingStoreState, PairedDevice } from "./device-pairing.types.js";
import { readSqliteDatabaseWriteRevision } from "./sqlite-database-admission.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";

type DevicePairingStoreCache = {
  connection: DatabaseSync;
  path: string;
  state: DevicePairingStoreState;
  writeRevision: number;
  revision: string;
};

// Writer settlement invalidates snapshots across connections and worker isolates.
const cache = resolveGlobalSingleton<{ value: DevicePairingStoreCache | undefined }>(
  Symbol.for("openclaw.devicePairingStoreCache"),
  () => ({ value: undefined }),
);

export function invalidateDevicePairingStoreCache(database: {
  db: DatabaseSync;
  path: string;
}): void {
  if (cache.value?.connection === database.db && cache.value.path === database.path) {
    cache.value = undefined;
  }
}

/** A content revision is comparable across reader and writer connections. */
export function resolveDevicePairingStoreRevision(paired: Record<string, PairedDevice>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.values(paired).toSorted((a, b) =>
          a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0,
        ),
      ),
    )
    .digest("hex");
}

/** Borrowed worker facts; projections must not mutate this revision's cached rows. */
export function readCachedDevicePairingStoreSnapshot(
  db: DatabaseSync,
  path: string,
  read: () => DevicePairingStoreState,
): Pick<DevicePairingStoreCache, "state" | "revision"> {
  if (db.isTransaction) {
    const state = read();
    return { state, revision: resolveDevicePairingStoreRevision(state.pairedByDeviceId) };
  }
  const writeRevision = readSqliteDatabaseWriteRevision(db);
  const cached = cache.value;
  if (
    writeRevision !== undefined &&
    cached?.connection === db &&
    cached.path === path &&
    cached.writeRevision === writeRevision
  ) {
    return cached;
  }
  const state = runSqliteDeferredTransactionSync(db, read, {
    operationLabel: "devicePairing.snapshot",
  });
  const revision = resolveDevicePairingStoreRevision(state.pairedByDeviceId);
  const snapshot = { state, revision };
  if (writeRevision !== undefined && readSqliteDatabaseWriteRevision(db) === writeRevision) {
    cache.value = { connection: db, path, ...snapshot, writeRevision };
  }
  return snapshot;
}
