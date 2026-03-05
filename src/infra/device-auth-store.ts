import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { Vault } from "../security/vault/types.js";
import {
  isVaultEncrypted,
  vaultDecryptFileContent,
  vaultEncryptForWrite,
} from "../security/vault/vault.js";
import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import {
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
  type DeviceAuthStore,
} from "../shared/device-auth.js";

const DEVICE_AUTH_FILE = "device-auth.json";

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
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

function writeStore(filePath: string, store: DeviceAuthStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const filePath = resolveDeviceAuthPath(params.env);
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => readStore(filePath), writeStore: (_store) => {} },
    deviceId: params.deviceId,
    role: params.role,
  });
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry {
  const filePath = resolveDeviceAuthPath(params.env);
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const filePath = resolveDeviceAuthPath(params.env);
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}

/** Vault-aware read of device auth store. Decrypts if encrypted. */
async function readStoreDecrypted(
  filePath: string,
  vault?: Vault | null,
): Promise<DeviceAuthStore | null> {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    let json = raw;
    if (vault && isVaultEncrypted(raw)) {
      json = await vaultDecryptFileContent(raw, vault);
    }
    const parsed = JSON.parse(json) as DeviceAuthStore;
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
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

/** Vault-aware write of device auth store. Encrypts if vault is provided. */
async function writeStoreEncrypted(
  filePath: string,
  store: DeviceAuthStore,
  vault?: Vault | null,
): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = `${JSON.stringify(store, null, 2)}\n`;
  const toWrite = await vaultEncryptForWrite(json, vault ?? null);
  fs.writeFileSync(filePath, toWrite, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** Vault-aware load of a device auth token. */
export async function loadDeviceAuthTokenEncrypted(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
  vault?: Vault | null;
}): Promise<DeviceAuthEntry | null> {
  const filePath = resolveDeviceAuthPath(params.env);
  const store = await readStoreDecrypted(filePath, params.vault);
  if (!store) {
    return null;
  }
  if (store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  const entry = store.tokens[role];
  if (!entry || typeof entry.token !== "string") {
    return null;
  }
  return entry;
}

/** Vault-aware store of a device auth token. */
export async function storeDeviceAuthTokenEncrypted(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
  vault?: Vault | null;
}): Promise<DeviceAuthEntry> {
  const filePath = resolveDeviceAuthPath(params.env);
  const existing = await readStoreDecrypted(filePath, params.vault);
  const role = normalizeDeviceAuthRole(params.role);
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
  await writeStoreEncrypted(filePath, next, params.vault);
  return entry;
}
