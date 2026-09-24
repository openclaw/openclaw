// TTS preference mutations stay off the agent prompt's read-only import path.
import path from "node:path";
import type { TtsAutoMode, TtsProvider } from "../config/types.js";
import { privateFileStoreSync } from "../infra/private-file-store.js";
import { canonicalizeSpeechProviderId } from "./provider-registry.js";
import { normalizeTtsPersonaId, readTtsPrefsForUpdate, type TtsUserPrefs } from "./tts-settings.js";

/**
 * Apply a mutation and rewrite the prefs file.
 *
 * When an existing file could not be read (oversized), the update is refused so the
 * unreadable file and every setting it still holds stay intact. Reporting failure is
 * the safe outcome: rewriting would persist a defaults-only object over the
 * operator's real prefs.
 */
function updateTtsPrefs(prefsPath: string, update: (prefs: TtsUserPrefs) => void): void {
  const prefs = readTtsPrefsForUpdate(prefsPath);
  if (!prefs) {
    throw new Error(
      `Refusing to update TTS preferences: ${prefsPath} could not be read (it is larger than the supported size).`,
    );
  }
  update(prefs);
  privateFileStoreSync(path.dirname(prefsPath)).writeText(
    path.basename(prefsPath),
    JSON.stringify(prefs, null, 2),
  );
}

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function setTtsPersona(prefsPath: string, persona: string | null | undefined): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    next.persona = normalizeTtsPersonaId(persona) ?? null;
    prefs.tts = next;
  });
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider: canonicalizeSpeechProviderId(provider) ?? provider };
  });
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updateTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}
