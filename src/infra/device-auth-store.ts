import { z } from "zod";
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
const DeviceAuthStoreSchema = z.object({
  version: z.literal(1),
  deviceId: z.string(),
  tokens: z.record(z.string(), z.unknown()),
}) as z.ZodType<DeviceAuthStore>;

function sqliteOptions(env: NodeJS.ProcessEnv | undefined): OpenClawStateDatabaseOptions {
  return env ? { env } : {};
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

export function parseDeviceAuthStoreForMigration(raw: unknown): DeviceAuthStore | null {
  const store = DeviceAuthStoreSchema.safeParse(raw);
  return store.success ? store.data : null;
}

export function writeDeviceAuthStoreForMigration(
  env: NodeJS.ProcessEnv | undefined,
  store: DeviceAuthStore,
): void {
  writeStore(env, store);
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
