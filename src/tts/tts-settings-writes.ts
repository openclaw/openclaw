// TTS preference mutations stay off the agent prompt's read-only import path.
import type { TtsAutoMode, TtsProvider } from "../config/types.js";
import { canonicalizeSpeechProviderId } from "./provider-registry.js";
import { updateTtsPrefsSync } from "./tts-settings-write-worker.js";

export function setTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updateTtsPrefsSync(prefsPath, { auto: mode });
}

export function setTtsEnabled(prefsPath: string, enabled: boolean): void {
  setTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function setTtsPersona(prefsPath: string, persona: string | null | undefined): void {
  updateTtsPrefsSync(prefsPath, { persona: persona ?? null });
}

export function setTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updateTtsPrefsSync(prefsPath, { provider: canonicalizeSpeechProviderId(provider) ?? provider });
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updateTtsPrefsSync(prefsPath, { maxLength });
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updateTtsPrefsSync(prefsPath, { summarize: enabled });
}
