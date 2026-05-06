import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import type { DeviceAuthStore } from "../shared/device-auth.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

const DEVICE_AUTH_SCOPE = "identity.device-auth";
const DEVICE_AUTH_KEY = "default";
const DEVICE_AUTH_FILE = "device-auth.json";
const DeviceAuthStoreSchema = z.object({
  version: z.literal(1),
  deviceId: z.string(),
  tokens: z.record(z.string(), z.unknown()),
}) as z.ZodType<DeviceAuthStore>;

function sqliteOptions(env: NodeJS.ProcessEnv | undefined): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
}

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function readStore(env?: NodeJS.ProcessEnv): DeviceAuthStore | null {
  try {
    const parsed = readOpenClawStateKvJson(DEVICE_AUTH_SCOPE, DEVICE_AUTH_KEY, sqliteOptions(env));
    const store = DeviceAuthStoreSchema.safeParse(parsed);
    return store.success ? store.data : null;
  } catch {
    return null;
  }
}

function writeStore(env: NodeJS.ProcessEnv | undefined, store: DeviceAuthStore): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    DEVICE_AUTH_SCOPE,
    DEVICE_AUTH_KEY,
    store as unknown as OpenClawStateJsonValue,
    sqliteOptions(env),
  );
}

export function loadDeviceAuthStore(
  params: { env?: NodeJS.ProcessEnv } = {},
): DeviceAuthStore | null {
  return readStore(params.env);
}

export function storeDeviceAuthStore(params: {
  store: DeviceAuthStore;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthStore {
  writeStore(params.env, params.store);
  return params.store;
}

export function legacyDeviceAuthFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.existsSync(resolveDeviceAuthPath(env));
  } catch {
    return false;
  }
}

export function importLegacyDeviceAuthFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
  tokens: number;
} {
  const filePath = resolveDeviceAuthPath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, tokens: 0 };
    }
    throw error;
  }
  const store = DeviceAuthStoreSchema.safeParse(parsed);
  if (!store.success) {
    return { imported: false, tokens: 0 };
  }
  writeStore(env, store.data);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, tokens: Object.keys(store.data.tokens).length };
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => readStore(params.env), writeStore: (_store) => {} },
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
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(params.env),
      writeStore: (store) => writeStore(params.env, store),
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
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(params.env),
      writeStore: (store) => writeStore(params.env, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}
