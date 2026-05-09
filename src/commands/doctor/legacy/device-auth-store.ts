import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  parseDeviceAuthStoreForMigration,
  writeDeviceAuthStoreForMigration,
} from "../../../infra/device-auth-store.js";

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", "device-auth.json");
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
  const store = parseDeviceAuthStoreForMigration(parsed);
  if (!store) {
    return { imported: false, tokens: 0 };
  }
  writeDeviceAuthStoreForMigration(env, store);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, tokens: Object.keys(store.tokens).length };
}
