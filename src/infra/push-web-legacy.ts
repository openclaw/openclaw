import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  writeWebPushRegistrationStateForMigration,
  writeWebPushVapidKeysForMigration,
  type VapidKeyPair,
  type WebPushRegistrationState,
} from "./push-web.js";

const LEGACY_WEB_PUSH_STATE_FILENAME = "push/web-push-subscriptions.json";
const LEGACY_VAPID_KEYS_FILENAME = "push/vapid-keys.json";

function resolveLegacyWebPushStatePath(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), LEGACY_WEB_PUSH_STATE_FILENAME);
}

function resolveLegacyVapidKeysPath(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), LEGACY_VAPID_KEYS_FILENAME);
}

export async function legacyWebPushFilesExist(baseDir?: string): Promise<boolean> {
  const [stateExists, vapidExists] = await Promise.all([
    fs
      .access(resolveLegacyWebPushStatePath(baseDir))
      .then(() => true)
      .catch(() => false),
    fs
      .access(resolveLegacyVapidKeysPath(baseDir))
      .then(() => true)
      .catch(() => false),
  ]);
  return stateExists || vapidExists;
}

export async function importLegacyWebPushFilesToSqlite(baseDir?: string): Promise<{
  subscriptions: number;
  importedVapidKeys: boolean;
  files: number;
}> {
  let files = 0;
  let subscriptions = 0;
  let importedVapidKeys = false;
  const statePath = resolveLegacyWebPushStatePath(baseDir);
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as WebPushRegistrationState;
    if (state && typeof state === "object") {
      await writeWebPushRegistrationStateForMigration(state, baseDir);
      subscriptions = Object.keys(state.subscriptionsByEndpointHash ?? {}).length;
      await fs.rm(statePath, { force: true }).catch(() => undefined);
      files += 1;
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "ENOENT") {
      throw error;
    }
  }

  const vapidPath = resolveLegacyVapidKeysPath(baseDir);
  try {
    const keys = JSON.parse(await fs.readFile(vapidPath, "utf8")) as VapidKeyPair;
    if (keys?.publicKey && keys.privateKey) {
      writeWebPushVapidKeysForMigration(keys, baseDir);
      await fs.rm(vapidPath, { force: true }).catch(() => undefined);
      importedVapidKeys = true;
      files += 1;
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "ENOENT") {
      throw error;
    }
  }
  return { subscriptions, importedVapidKeys, files };
}
