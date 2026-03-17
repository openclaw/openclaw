import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { elevenLabsTTS } from "../tts-core.js";

const ELEVENLABS_TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_monolingual_v1",
] as const;

export function buildElevenLabsSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    models: ELEVENLABS_TTS_MODELS,
    isConfigured: ({ config }) =>
      Boolean(config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY),
    synthesize: async (req) => {
      const apiKey =
        req.config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const outputFormat = req.target === "voice-note" ? "opus_48000_64" : "mp3_44100_128";
      const audioBuffer = await elevenLabsTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.elevenlabs.baseUrl,
        voiceId: req.overrides?.elevenlabs?.voiceId ?? req.config.elevenlabs.voiceId,
        modelId: req.overrides?.elevenlabs?.modelId ?? req.config.elevenlabs.modelId,
        outputFormat,
        seed: req.overrides?.elevenlabs?.seed ?? req.config.elevenlabs.seed,
        applyTextNormalization:
          req.overrides?.elevenlabs?.applyTextNormalization ??
          req.config.elevenlabs.applyTextNormalization,
        languageCode: req.overrides?.elevenlabs?.languageCode ?? req.config.elevenlabs.languageCode,
        voiceSettings: {
          ...req.config.elevenlabs.voiceSettings,
          ...req.overrides?.elevenlabs?.voiceSettings,
        },
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: req.target === "voice-note" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey =
        req.config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key missing");
      }
      const outputFormat = "pcm_22050";
      const sampleRate = 22_050;
      const audioBuffer = await elevenLabsTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.elevenlabs.baseUrl,
        voiceId: req.config.elevenlabs.voiceId,
        modelId: req.config.elevenlabs.modelId,
        outputFormat,
        seed: req.config.elevenlabs.seed,
        applyTextNormalization: req.config.elevenlabs.applyTextNormalization,
        languageCode: req.config.elevenlabs.languageCode,
        voiceSettings: req.config.elevenlabs.voiceSettings,
        timeoutMs: req.config.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
