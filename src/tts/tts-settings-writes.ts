// TTS preference mutations stay off the agent prompt's read-only import path.
import path from "node:path";
import type { TtsAutoMode, TtsProvider } from "../config/types.js";
import { privateFileStoreSync } from "../infra/private-file-store.js";
import { canonicalizeSpeechProviderId } from "./provider-registry.js";
import { normalizeTtsPersonaId, readTtsPrefs, type TtsUserPrefs } from "./tts-settings.js";

function updateTtsPrefs(
  prefsPath: string,
  update: (tts: TtsUserPrefs["tts"]) => TtsUserPrefs["tts"],
): void {
  const prefs = readTtsPrefs(prefsPath);
  prefs.tts = update(prefs.tts);
  privateFileStoreSync(path.dirname(prefsPath)).writeText(
    path.basename(prefsPath),
    JSON.stringify(prefs, null, 2),
  );
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updateTtsPrefs(prefsPath, (tts) => {
    const { enabled: _enabled, ...next } = { ...tts };
    return { ...next, auto: mode };
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function setTtsPersona(prefsPath: string, persona: string | null | undefined): void {
  updateTtsPrefs(prefsPath, (tts) => ({ ...tts, persona: normalizeTtsPersonaId(persona) ?? null }));
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updateTtsPrefs(prefsPath, (tts) => ({
    ...tts,
    provider: canonicalizeSpeechProviderId(provider) ?? provider,
  }));
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updateTtsPrefs(prefsPath, (tts) => ({ ...tts, maxLength }));
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updateTtsPrefs(prefsPath, (tts) => ({ ...tts, summarize: enabled }));
}
