export type TtsProvider = "elevenlabs" | "openai" | "edge" | "chatterbox" | "piper" | "kokoro";

export type TtsMode = "final" | "all";

export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";

export type TtsModelOverrideConfig = {
  /** Enable model-provided overrides for TTS. */
  enabled?: boolean;
  /** Allow model-provided TTS text blocks. */
  allowText?: boolean;
  /** Allow model-provided provider override (default: false). */
  allowProvider?: boolean;
  /** Allow model-provided voice/voiceId override. */
  allowVoice?: boolean;
  /** Allow model-provided modelId override. */
  allowModelId?: boolean;
  /** Allow model-provided voice settings override. */
  allowVoiceSettings?: boolean;
  /** Allow model-provided normalization or language overrides. */
  allowNormalization?: boolean;
  /** Allow model-provided seed override. */
  allowSeed?: boolean;
};

export type TtsConfig = {
  /** Auto-TTS mode (preferred). */
  auto?: TtsAutoMode;
  /** Legacy: enable auto-TTS when `auto` is not set. */
  enabled?: boolean;
  /** Apply TTS to final replies only or to all replies (tool/block/final). */
  mode?: TtsMode;
  /** Primary TTS provider (fallbacks are automatic). */
  provider?: TtsProvider;
  /** Optional model override for TTS auto-summary (provider/model or alias). */
  summaryModel?: string;
  /** Allow the model to override TTS parameters. */
  modelOverrides?: TtsModelOverrideConfig;
  /** ElevenLabs configuration. */
  elevenlabs?: {
    apiKey?: string;
    baseUrl?: string;
    voiceId?: string;
    modelId?: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
      speed?: number;
    };
  };
  /** OpenAI configuration. */
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  /** Microsoft Edge (node-edge-tts) configuration. */
  edge?: {
    /** Explicitly allow Edge TTS usage (no API key required). */
    enabled?: boolean;
    voice?: string;
    lang?: string;
    outputFormat?: string;
    pitch?: string;
    rate?: string;
    volume?: string;
    saveSubtitles?: boolean;
    proxy?: string;
    timeoutMs?: number;
  };
  /** Chatterbox TTS configuration (local or self-hosted). */
  chatterbox?: {
    /** Explicitly enable Chatterbox TTS. */
    enabled?: boolean;
    /** Base URL for Chatterbox API (default: http://localhost:4123). */
    baseUrl?: string;
    /** Optional API key if your Chatterbox instance requires auth. */
    apiKey?: string;
    /** Voice name from voice library (e.g., "default", "sarah"). */
    voice?: string;
    /** Model variant: "chatterbox" | "chatterbox-turbo" | "chatterbox-multilingual". */
    model?: string;
    /** Language code for multilingual model (e.g., "en", "ar", "fr"). */
    language?: string;
    /** Exaggeration parameter (0.0-1.0, default 0.5). */
    exaggeration?: number;
    /** CFG weight parameter (0.0-1.0, default 0.5). */
    cfgWeight?: number;
    /** Speed multiplier (0.5-2.0, default 1.0). */
    speed?: number;
  };
  /** Piper TTS configuration (local or self-hosted). */
  piper?: {
    /** Explicitly enable Piper TTS. */
    enabled?: boolean;
    /** Base URL for Piper API (default: http://localhost:8101). */
    baseUrl?: string;
    /** Optional API key if your Piper instance requires auth. */
    apiKey?: string;
    /** Voice model name (e.g., "en_US-lessac-high", "en_GB-alba-medium"). */
    voice?: string;
    /** Speaker ID for multi-speaker models. */
    speakerId?: number;
    /** Length scale / speed (0.5-2.0, default 1.0). Smaller = faster. */
    lengthScale?: number;
    /** Noise scale for audio variation (0.0-1.0, default 0.667). */
    noiseScale?: number;
    /** Noise weight for phoneme duration variation (0.0-1.0, default 0.8). */
    noiseW?: number;
    /** Sentence silence duration in seconds (default 0.2). */
    sentenceSilence?: number;
  };
  /** Kokoro-82M TTS configuration (local or self-hosted, fastest CUDA TTS). */
  kokoro?: {
    /** Explicitly enable Kokoro TTS. */
    enabled?: boolean;
    /** Base URL for Kokoro API (default: http://localhost:8102). */
    baseUrl?: string;
    /** Optional API key if your Kokoro instance requires auth. */
    apiKey?: string;
    /** Voice name (e.g., "af_bella", "af_sky", "am_adam"). Supports voice mixing with "+". */
    voice?: string;
    /** Speed multiplier (0.5-2.0, default 1.0). */
    speed?: number;
  };
  /** Optional path for local TTS user preferences JSON. */
  prefsPath?: string;
  /** Hard cap for text sent to TTS (chars). */
  maxTextLength?: number;
  /** API request timeout (ms). */
  timeoutMs?: number;
};
