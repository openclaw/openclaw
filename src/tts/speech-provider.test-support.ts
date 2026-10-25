import type { SpeechProviderPlugin } from "../plugins/types.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";

export function createFullSpeechPolicy(): SpeechModelOverridePolicy {
  return {
    enabled: true,
    allowText: true,
    allowProvider: true,
    allowVoice: true,
    allowModelId: true,
    allowVoiceSettings: true,
    allowNormalization: true,
    allowSeed: true,
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
