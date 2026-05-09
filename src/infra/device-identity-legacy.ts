import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  parseStoredDeviceIdentityForMigration,
  writeStoredDeviceIdentityForMigration,
} from "./device-identity.js";

function resolveIdentityPathForEnv(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", "device.json");
}

export function legacyDeviceIdentityFileExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.existsSync(resolveIdentityPathForEnv(env));
  } catch {
    return false;
  }
}

export function importLegacyDeviceIdentityFileToSqlite(env: NodeJS.ProcessEnv = process.env): {
  imported: boolean;
} {
  const filePath = resolveIdentityPathForEnv(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false };
    }
    throw error;
  }
  const stored = parseStoredDeviceIdentityForMigration(parsed);
  if (!stored) {
    return { imported: false };
  }
  writeStoredDeviceIdentityForMigration(filePath, stored);
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true };
}
