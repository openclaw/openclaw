import type { TtsEngine, TtsSynthesizeRequest, TtsSynthesizeResult } from "../engine.js";
import {
  isValidVoiceId,
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
} from "../tts-core.js";
import type { ResolvedTtsConfig } from "../tts.js";

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

function normalizeElevenLabsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return DEFAULT_ELEVENLABS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function requireInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

function assertVoiceSettings(settings: ResolvedTtsConfig["elevenlabs"]["voiceSettings"]) {
  requireInRange(settings.stability, 0, 1, "stability");
  requireInRange(settings.similarityBoost, 0, 1, "similarityBoost");
  requireInRange(settings.style, 0, 1, "style");
  requireInRange(settings.speed, 0.5, 2, "speed");
}

export class ElevenLabsTtsEngine implements TtsEngine {
  readonly id = "elevenlabs";

  constructor(
    private readonly config: ResolvedTtsConfig["elevenlabs"],
    private readonly apiKey: string | undefined,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  supportsTelephony(): boolean {
    return true;
  }

  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error("ElevenLabs TTS: no API key");
    }

    const overrides = request.overrides?.elevenlabs;
    const voiceId = overrides?.voiceId ?? this.config.voiceId;
    const modelId = overrides?.modelId ?? this.config.modelId;
    const voiceSettings = {
      ...this.config.voiceSettings,
      ...overrides?.voiceSettings,
    };
    const seed = overrides?.seed ?? this.config.seed;
    const applyTextNormalization =
      overrides?.applyTextNormalization ?? this.config.applyTextNormalization;
    const languageCode = overrides?.languageCode ?? this.config.languageCode;

    if (!isValidVoiceId(voiceId)) {
      throw new Error("Invalid voiceId format");
    }
    assertVoiceSettings(voiceSettings);
    const normalizedLanguage = normalizeLanguageCode(languageCode);
    const normalizedNormalization = normalizeApplyTextNormalization(applyTextNormalization);
    const normalizedSeed = normalizeSeed(seed);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const url = new URL(
        `${normalizeElevenLabsBaseUrl(this.config.baseUrl)}/v1/text-to-speech/${voiceId}`,
      );
      if (request.outputFormat) {
        url.searchParams.set("output_format", request.outputFormat);
      }

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: request.text,
          model_id: modelId,
          seed: normalizedSeed,
          apply_text_normalization: normalizedNormalization,
          language_code: normalizedLanguage,
          voice_settings: {
            stability: voiceSettings.stability,
            similarity_boost: voiceSettings.similarityBoost,
            style: voiceSettings.style,
            use_speaker_boost: voiceSettings.useSpeakerBoost,
            speed: voiceSettings.speed,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`ElevenLabs API error (${response.status})`);
      }

      return {
        audio: Buffer.from(await response.arrayBuffer()),
        format: request.outputFormat,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
