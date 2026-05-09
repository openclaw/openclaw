import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
import { privateFileStoreSync } from "../infra/private-file-store.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

const TTS_PREFS_PLUGIN_ID = "speech-core";
const TTS_PREFS_NAMESPACE = "tts-prefs";
const TTS_PREFS_KEY = "default";

export const SQLITE_TTS_PREFS_REF = "sqlite:plugin-state/speech-core/tts-prefs/default" as const;

export type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    persona?: string | null;
    maxLength?: number;
    summarize?: boolean;
  };
};

function openTtsPrefsStore(env: NodeJS.ProcessEnv = process.env) {
  return createPluginStateSyncKeyedStore<TtsUserPrefs>(TTS_PREFS_PLUGIN_ID, {
    namespace: TTS_PREFS_NAMESPACE,
    maxEntries: 8,
    env,
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coercePrefs(value: unknown): TtsUserPrefs {
  return isObjectRecord(value) ? (value as TtsUserPrefs) : {};
}

export function isSqliteTtsPrefsRef(value: string): boolean {
  return value === SQLITE_TTS_PREFS_REF;
}

export function resolveLegacyDefaultTtsPrefsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), "settings", "tts.json");
}

export function resolveTtsPrefsRef(
  prefsPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredPath = normalizeOptionalString(prefsPath);
  if (configuredPath) {
    return resolveUserPath(configuredPath, env);
  }
  const envPath = normalizeOptionalString(env.OPENCLAW_TTS_PREFS);
  if (envPath) {
    return resolveUserPath(envPath, env);
  }
  return SQLITE_TTS_PREFS_REF;
}

export function readTtsUserPrefs(
  prefsRef: string,
  env: NodeJS.ProcessEnv = process.env,
): TtsUserPrefs {
  if (isSqliteTtsPrefsRef(prefsRef)) {
    return coercePrefs(openTtsPrefsStore(env).lookup(TTS_PREFS_KEY));
  }
  try {
    if (!existsSync(prefsRef)) {
      return {};
    }
    return coercePrefs(JSON.parse(readFileSync(prefsRef, "utf8")) as unknown);
  } catch {
    return {};
  }
}

function writePrefsFile(filePath: string, prefs: TtsUserPrefs): void {
  privateFileStoreSync(path.dirname(filePath)).writeText(
    path.basename(filePath),
    JSON.stringify(prefs, null, 2),
  );
}

export function writeTtsUserPrefsForMigration(
  prefs: TtsUserPrefs,
  env: NodeJS.ProcessEnv = process.env,
): void {
  openTtsPrefsStore(env).register(TTS_PREFS_KEY, prefs);
}

export function updateTtsUserPrefs(
  prefsRef: string,
  update: (prefs: TtsUserPrefs) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const prefs = readTtsUserPrefs(prefsRef, env);
  update(prefs);
  if (isSqliteTtsPrefsRef(prefsRef)) {
    openTtsPrefsStore(env).register(TTS_PREFS_KEY, prefs);
    return;
  }
  writePrefsFile(prefsRef, prefs);
}
