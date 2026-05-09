import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  normalizeApnsRegistrationStateForMigration,
  writeApnsRegistrationStateForMigration,
} from "../../../infra/push-apns.js";

const LEGACY_APNS_STATE_FILENAME = "push/apns-registrations.json";

function resolveLegacyApnsRegistrationPath(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), LEGACY_APNS_STATE_FILENAME);
}

export async function legacyApnsRegistrationFileExists(baseDir?: string): Promise<boolean> {
  return await fs
    .access(resolveLegacyApnsRegistrationPath(baseDir))
    .then(() => true)
    .catch(() => false);
}

export async function importLegacyApnsRegistrationFileToSqlite(baseDir?: string): Promise<{
  imported: boolean;
  registrations: number;
}> {
  const filePath = resolveLegacyApnsRegistrationPath(baseDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, registrations: 0 };
    }
    throw error;
  }
  const normalized = normalizeApnsRegistrationStateForMigration(parsed);
  if (!normalized) {
    return { imported: false, registrations: 0 };
  }
  await writeApnsRegistrationStateForMigration(normalized, baseDir);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true, registrations: Object.keys(normalized.registrationsByNodeId).length };
}
