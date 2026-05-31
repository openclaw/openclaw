import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../../../src/shared/device-auth.js";
import { getSafeLocalStorage } from "../local-storage.ts";

const STORAGE_KEY = "openclaw.device.auth.v1";

function readStore(): DeviceAuthStore | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(STORAGE_KEY);
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

function writeStore(store: DeviceAuthStore) {
  try {
    getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = readStore();
  if (!store || store.deviceId !== params.deviceId) {
    return null;
  }
  const entry = store.tokens[normalizeDeviceAuthRole(params.role)];
  return entry && typeof entry.token === "string" ? entry : null;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const role = normalizeDeviceAuthRole(params.role);
  const existing = readStore();
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
  writeStore(next);
  return entry;
}

export function clearDeviceAuthToken(params: { deviceId: string; role: string }) {
  const store = readStore();
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
  writeStore(next);
}
