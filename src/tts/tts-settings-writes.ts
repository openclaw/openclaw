// TTS preference mutations stay off the agent prompt's read-only import path.
import path from "node:path";
import type { OpenClawConfig, TtsAutoMode, TtsProvider } from "../config/types.js";
import { privateFileStoreSync } from "../infra/private-file-store.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import {
  canonicalizeSpeechProviderId,
  canonicalizeSpeechProviderIdAsync,
  type SpeechProviderRegistry,
} from "./provider-registry.js";
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

/** @deprecated Use setTtsProviderAsync, or pass an already prepared provider registry. */
export function setTtsProvider(
  prefsPath: string,
  provider: TtsProvider,
  registry?: SpeechProviderRegistry,
): void {
  if (!registry) {
    warnPluginSdkDeprecation({
      family: "tts",
      method: "setTtsProvider",
      replacement: "setTtsProviderAsync",
      compatibility: "The synchronous API requires an already prepared and loaded speech registry.",
    });
  }
  writeTtsProvider(
    prefsPath,
    (registry?.canonicalizeSpeechProviderId ?? canonicalizeSpeechProviderId)(provider) ?? provider,
  );
}

export async function setTtsProviderAsync(
  prefsPath: string,
  provider: TtsProvider,
  cfg?: OpenClawConfig,
): Promise<void> {
  writeTtsProvider(prefsPath, (await canonicalizeSpeechProviderIdAsync(provider, cfg)) ?? provider);
}

function writeTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updateTtsPrefs(prefsPath, (tts) => ({
    ...tts,
    provider,
  }));
}

export function setTtsMaxLength(prefsPath: string, maxLength: number): void {
  updateTtsPrefs(prefsPath, (tts) => ({ ...tts, maxLength }));
}

export function setSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updateTtsPrefs(prefsPath, (tts) => ({ ...tts, summarize: enabled }));
}
