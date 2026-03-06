import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "./device-auth.js";
export type { DeviceAuthEntry, DeviceAuthStore } from "./device-auth.js";

export type DeviceAuthStoreAdapter = {
  readStore: () => DeviceAuthStore | null;
  writeStore: (store: DeviceAuthStore) => void;
};

export function loadDeviceAuthTokenFromStore(params: {
  adapter: DeviceAuthStoreAdapter;
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = params.adapter.readStore();
  if (!store || store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  const entry = store.tokens[role];
  if (!entry || typeof entry.token !== "string") {
    return null;
  }
  return entry;
}

export function storeDeviceAuthTokenInStore(params: {
  adapter: DeviceAuthStoreAdapter;
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const role = normalizeDeviceAuthRole(params.role);
  const existing = params.adapter.readStore();
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  params.adapter.writeStore(next);
  return entry;
}

export function clearDeviceAuthTokenFromStore(params: {
  adapter: DeviceAuthStoreAdapter;
  deviceId: string;
  role: string;
}): void {
  const store = params.adapter.readStore();
  if (!store || store.deviceId !== params.deviceId) {
    return;
  }
  const role = normalizeDeviceAuthRole(params.role);
  if (!store.tokens[role]) {
    return;
  }
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: store.deviceId,
    tokens: { ...store.tokens },
  };
  delete next.tokens[role];
  params.adapter.writeStore(next);
}
