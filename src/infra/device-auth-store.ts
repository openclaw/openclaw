import fs from "node:fs";
import path from "node:path";
import { debuglog } from "node:util";
import { resolveStateDir } from "../config/paths.js";
import {
  readCredentialJson,
  writeCredentialJson,
  type CredentialStoreOptions,
} from "../security/credential-store.js";
import {
  clearDeviceAuthTokenFromStore,
  type DeviceAuthEntry,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import type { DeviceAuthStore } from "../shared/device-auth.js";
import { resolveCredentialEncryptionOptions } from "./device-auth-encryption.js";
import { writeFileSecure } from "./json-file.js";

const debug = debuglog("openclaw:device-auth");
const DEVICE_AUTH_FILE = "device-auth.json";

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function readStore(
  filePath: string,
  encryptionOptions?: CredentialStoreOptions,
): DeviceAuthStore | null {
  try {
    const parsed = encryptionOptions
      ? (readCredentialJson(filePath, encryptionOptions) as DeviceAuthStore | undefined)
      : (() => {
          if (!fs.existsSync(filePath)) {
            return undefined;
          }
          const raw = fs.readFileSync(filePath, "utf8");
          return JSON.parse(raw) as DeviceAuthStore;
        })();
    if (!parsed) {
      return null;
    }
    if (parsed?.version !== 1 || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch (err) {
    debug("readStore failed for %s: %O", filePath, err);
    return null;
  }
}

function writeStore(
  filePath: string,
  store: DeviceAuthStore,
  encryptionOptions?: CredentialStoreOptions,
): void {
  if (encryptionOptions) {
    writeCredentialJson(filePath, store, encryptionOptions);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSecure(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const filePath = resolveDeviceAuthPath(params.env);
  const encOpts = resolveCredentialEncryptionOptions(params.env);
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => readStore(filePath, encOpts), writeStore: (_store) => {} },
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
  const encOpts = resolveCredentialEncryptionOptions(params.env);
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(filePath, encOpts),
      writeStore: (store) => writeStore(filePath, store, encOpts),
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
  const encOpts = resolveCredentialEncryptionOptions(params.env);
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(filePath, encOpts),
      writeStore: (store) => writeStore(filePath, store, encOpts),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}
