import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";

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

export function resolveTtsPrefsRef(
  _prefsPath?: string,
  _env: NodeJS.ProcessEnv = process.env,
): string {
  return SQLITE_TTS_PREFS_REF;
}

export function readTtsUserPrefs(
  _prefsRef: string,
  env: NodeJS.ProcessEnv = process.env,
): TtsUserPrefs {
  return coercePrefs(openTtsPrefsStore(env).lookup(TTS_PREFS_KEY));
}

export function writeTtsUserPrefsSnapshot(
  prefs: TtsUserPrefs,
  env: NodeJS.ProcessEnv = process.env,
): void {
  openTtsPrefsStore(env).register(TTS_PREFS_KEY, prefs);
}

export function updateTtsUserPrefs(
  _prefsRef: string,
  update: (prefs: TtsUserPrefs) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const prefs = readTtsUserPrefs(SQLITE_TTS_PREFS_REF, env);
  update(prefs);
  openTtsPrefsStore(env).register(TTS_PREFS_KEY, prefs);
}
