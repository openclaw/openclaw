import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  normalizeVoiceWakeConfigForMigration,
  writeVoiceWakeConfigForMigration,
} from "../../../infra/voicewake.js";

function resolveLegacyPath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake.json");
}

export async function legacyVoiceWakeConfigFileExists(baseDir?: string): Promise<boolean> {
  try {
    await fs.access(resolveLegacyPath(baseDir));
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function importLegacyVoiceWakeConfigFileToSqlite(baseDir?: string): Promise<{
  imported: boolean;
  triggers: number;
}> {
  const filePath = resolveLegacyPath(baseDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, triggers: 0 };
    }
    throw error;
  }
  const normalized = normalizeVoiceWakeConfigForMigration(raw);
  writeVoiceWakeConfigForMigration(normalized, baseDir);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true, triggers: normalized.triggers.length };
}
