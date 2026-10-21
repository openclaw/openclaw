import type { SpeechProviderPlugin } from "../plugins/types.js";

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
