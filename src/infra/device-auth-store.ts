import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import type { DeviceAuthStore } from "../shared/device-auth.js";
import { getCoreSettingFromDb, setCoreSettingInDb } from "./state-db/core-settings-sqlite.js";

const SCOPE = "device-auth";

function makeAdapter() {
  return {
    readStore: () => getCoreSettingFromDb<DeviceAuthStore>(SCOPE),
    writeStore: (store: DeviceAuthStore) => setCoreSettingInDb(SCOPE, "", store),
  };
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  return loadDeviceAuthTokenFromStore({
    adapter: makeAdapter(),
    deviceId: params.deviceId,
    role: params.role,
  });
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  return storeDeviceAuthTokenInStore({
    adapter: makeAdapter(),
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearDeviceAuthToken(params: { deviceId: string; role: string }): void {
  clearDeviceAuthTokenFromStore({
    adapter: makeAdapter(),
    deviceId: params.deviceId,
    role: params.role,
  });
}
