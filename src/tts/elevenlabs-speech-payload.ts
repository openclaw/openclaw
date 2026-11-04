export const DEFAULT_ELEVENLABS_VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
export const DEFAULT_ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
  speed: 1,
};

export const ELEVENLABS_TTS_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_flash_v2",
  "eleven_turbo_v2_5",
  "eleven_monolingual_v1",
] as const;

export function buildElevenLabsSpeechRequestBody(params: {
  text: string;
  modelId: string;
  seed?: number;
  applyTextNormalization?: string;
  languageCode?: string;
  voiceSettings: typeof DEFAULT_ELEVENLABS_VOICE_SETTINGS;
}) {
  return {
    text: params.text,
    model_id: params.modelId,
    seed: params.seed,
    apply_text_normalization: params.applyTextNormalization,
    language_code: params.languageCode,
    voice_settings: {
      stability: params.voiceSettings.stability,
      similarity_boost: params.voiceSettings.similarityBoost,
      style: params.voiceSettings.style,
      use_speaker_boost: params.voiceSettings.useSpeakerBoost,
      speed: params.voiceSettings.speed,
    },
  };
}
