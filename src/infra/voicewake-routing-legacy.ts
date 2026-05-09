import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeVoiceWakeRoutingConfig,
  writeVoiceWakeRoutingConfigForMigration,
} from "./voicewake-routing.js";

function resolveLegacyPath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake-routing.json");
}

export async function legacyVoiceWakeRoutingConfigFileExists(baseDir?: string): Promise<boolean> {
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

export async function importLegacyVoiceWakeRoutingConfigFileToSqlite(baseDir?: string): Promise<{
  imported: boolean;
  routes: number;
}> {
  const filePath = resolveLegacyPath(baseDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, routes: 0 };
    }
    throw error;
  }
  const normalized = normalizeVoiceWakeRoutingConfig(raw);
  writeVoiceWakeRoutingConfigForMigration(normalized, baseDir);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true, routes: normalized.routes.length };
}
