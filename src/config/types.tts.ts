import type { SecretInput } from "./types.secrets.js";

export type TtsProvider = string;

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

// =============================================================================
// CLI TTS Provider Configuration
// =============================================================================

/** Per-agent CLI TTS override config. */
export type CliTtsAgentConfig = {
  /** CLI command to execute (e.g., "tts-cli", "/usr/local/bin/tts"). */
  command?: string;
  /** Argument templates with {{...}} placeholders (e.g., ["--output", "{{OutputPath}}", "{{Text}}"]). */
  args?: string[];
  /** Output audio format. */
  outputFormat?: "mp3" | "opus" | "wav";
  /** Timeout in milliseconds (default: 120000). */
  timeoutMs?: number;
  /** Working directory for CLI execution. */
  cwd?: string;
  /** Environment variables to pass to CLI. */
  env?: Record<string, string>;
};

/** CLI TTS provider configuration. */
export type CliTtsProviderConfig = CliTtsAgentConfig & {
  /** CLI command to execute (required at provider level). */
  command: string;
  /** Per-agent CLI TTS overrides keyed by agent id. */
  agents?: Record<string, CliTtsAgentConfig>;
};

// =============================================================================

export type TtsProviderConfigMap = Record<string, Record<string, unknown>>;

export type LegacyTtsConfigCompat = {
  /** Legacy ElevenLabs configuration. Prefer providers.elevenlabs. */
  elevenlabs?: {
    apiKey?: SecretInput;
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
  /** Legacy OpenAI configuration. Prefer providers.openai. */
  openai?: {
    apiKey?: SecretInput;
    baseUrl?: string;
    model?: string;
    voice?: string;
    /** Playback speed (0.25–4.0, default 1.0). */
    speed?: number;
    /** System-level instructions for the TTS model (gpt-4o-mini-tts only). */
    instructions?: string;
  };
  /** Legacy alias for Microsoft speech configuration. Prefer providers.microsoft. */
  edge?: {
    /** Explicitly allow Microsoft speech usage (no API key required). */
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
  /** Legacy Microsoft speech configuration. Prefer providers.microsoft. */
  microsoft?: {
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
};

export type TtsConfig = LegacyTtsConfigCompat & {
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
  /** Provider-specific TTS settings keyed by speech provider id. */
  providers?: TtsProviderConfigMap;
  /** Optional path for local TTS user preferences JSON. */
  prefsPath?: string;
  /** Hard cap for text sent to TTS (chars). */
  maxTextLength?: number;
  /** API request timeout (ms). */
  timeoutMs?: number;
};
