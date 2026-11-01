import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";

export function createSpeechPolicy(allowed: boolean): SpeechModelOverridePolicy {
  return {
    enabled: allowed,
    allowText: allowed,
    allowProvider: allowed,
    allowVoice: allowed,
    allowModelId: allowed,
    allowVoiceSettings: allowed,
    allowNormalization: allowed,
    allowSeed: allowed,
  };
}

export function speechProvider(
  id: string,
  overrides: Partial<SpeechProviderPlugin> = {},
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.from("audio"),
      outputFormat: "mp3",
      voiceCompatible: false,
      fileExtension: ".mp3",
    }),
    ...overrides,
  };
}
