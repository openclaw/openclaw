import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DevicePairingStoreState, PairedDevice } from "./device-pairing.types.js";
import { readSqliteDataVersion } from "./node-sqlite.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";

type DevicePairingStoreCache = {
  connection: DatabaseSync;
  path: string;
  state: DevicePairingStoreState;
  dataVersion: number;
  revision: string;
};

// Store writes invalidate after commit; data_version catches commits on other connections.
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
  const dataVersion = readSqliteDataVersion(db);
  const cached = cache.value;
  if (cached?.connection === db && cached.path === path && cached.dataVersion === dataVersion) {
    return cached;
  }
  const state = runSqliteDeferredTransactionSync(db, read);
  const revision = resolveDevicePairingStoreRevision(state.pairedByDeviceId);
  cache.value = { connection: db, path, state, dataVersion, revision };
  return cache.value;
}
