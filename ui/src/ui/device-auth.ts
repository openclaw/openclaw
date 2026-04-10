import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../../../src/shared/device-auth-store.js";
import type { DeviceAuthStore } from "../../../src/shared/device-auth.js";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";

const STORAGE_KEY = "openclaw.device.auth.v1";

function readStoreFrom(storage: Storage | null): DeviceAuthStore | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (!parsed || parsed.version !== 1) {
      return null;
    }
    if (!parsed.deviceId || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readStore(): DeviceAuthStore | null {
  const sessionStore = readStoreFrom(getSafeSessionStorage());
  if (sessionStore) {
    return sessionStore;
  }
  const legacyStore = readStoreFrom(getSafeLocalStorage());
  if (legacyStore) {
    writeStore(legacyStore);
    try {
      getSafeLocalStorage()?.removeItem(STORAGE_KEY);
    } catch {
      // best-effort legacy scrub
    }
  }
  return legacyStore;
}

function writeStore(store: DeviceAuthStore) {
  try {
    getSafeSessionStorage()?.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore, writeStore },
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
    adapter: { readStore, writeStore },
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearDeviceAuthToken(params: { deviceId: string; role: string }) {
  clearDeviceAuthTokenFromStore({
    adapter: { readStore, writeStore },
    deviceId: params.deviceId,
    role: params.role,
  });
  try {
    getSafeLocalStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // best-effort legacy scrub
  }
}
