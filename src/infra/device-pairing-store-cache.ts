import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { DevicePairingStoreState } from "./device-pairing.types.js";

export type DevicePairingStoreValidityToken = {
  dataVersion: number;
  totalChanges: number;
};

type DevicePairingStoreCache = {
  connection: OpenClawStateDatabase["db"];
  path: string;
  state: DevicePairingStoreState;
  validityToken: DevicePairingStoreValidityToken;
};

// Both connection-local and other-process changes must invalidate the snapshot.
let cache: DevicePairingStoreCache | undefined;

export function readCachedDevicePairingStoreState(
  database: OpenClawStateDatabase,
  validityToken: DevicePairingStoreValidityToken,
  read: () => DevicePairingStoreState,
): DevicePairingStoreState {
  if (
    cache?.connection === database.db &&
    cache.path === database.path &&
    cache.validityToken.dataVersion === validityToken.dataVersion &&
    cache.validityToken.totalChanges === validityToken.totalChanges
  ) {
    return structuredClone(cache.state);
  }
  const state = read();
  cache = {
    connection: database.db,
    path: database.path,
    state: structuredClone(state),
    validityToken,
  };
  return state;
}

export function invalidateDevicePairingStoreCache(database: OpenClawStateDatabase): void {
  if (cache?.connection === database.db && cache.path === database.path) {
    cache = undefined;
  }
}
