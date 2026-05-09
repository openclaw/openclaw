import fs from "node:fs/promises";
import {
  resolveLegacyDefaultTtsPrefsPath,
  writeTtsUserPrefsForMigration,
  type TtsUserPrefs,
} from "../../../tts/tts-prefs-store.js";

function coerceTtsPrefs(value: unknown): TtsUserPrefs {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TtsUserPrefs) : {};
}

export async function legacyTtsPrefsFileExists(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await fs.access(resolveLegacyDefaultTtsPrefsPath(env));
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function importLegacyTtsPrefsFileToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ imported: boolean }> {
  const filePath = resolveLegacyDefaultTtsPrefsPath(env);
  let prefs: TtsUserPrefs;
  try {
    prefs = coerceTtsPrefs(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false };
    }
    prefs = {};
  }
  writeTtsUserPrefsForMigration(prefs, env);
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true };
}
