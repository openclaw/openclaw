export type TtsProvider = "elevenlabs" | "openai";

export type TtsMode = "final" | "all";

export type TtsConfig = {
  /** Enable auto-TTS (can be overridden by local prefs). */
  enabled?: boolean;
  /** Apply TTS to final replies only or to all replies (tool/block/final). */
  mode?: TtsMode;
  /** Primary TTS provider (fallbacks are automatic). */
  provider?: TtsProvider;
  /** ElevenLabs configuration. */
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  /** OpenAI configuration. */
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  /** Optional path for local TTS user preferences JSON. */
  prefsPath?: string;
  /** Hard cap for text sent to TTS (chars). */
  maxTextLength?: number;
  /** API request timeout (ms). */
  timeoutMs?: number;
};
