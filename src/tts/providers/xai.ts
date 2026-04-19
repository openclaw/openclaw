import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { openaiTTS } from "../tts-core.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_VOICE = "alloy";
const DEFAULT_XAI_MODEL = "gpt-4o-mini-tts";

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return (trimmed || DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
}

export function buildXaiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "xai",
    label: "xAI",
    isConfigured: ({ config }) => Boolean(config.xai.apiKey || process.env.XAI_API_KEY),
    synthesize: async (req) => {
      const apiKey = req.config.xai.apiKey || process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("xAI API key missing");
      }
      const outputFormat = req.target === "voice-note" ? "opus" : "mp3";
      const audioBuffer = await openaiTTS({
        text: req.text,
        apiKey,
        baseUrl: normalizeBaseUrl(req.config.xai.baseUrl),
        model: req.overrides?.xai?.model ?? req.config.xai.model ?? DEFAULT_XAI_MODEL,
        voice:
          req.overrides?.xai?.voiceId ??
          req.overrides?.xai?.voice ??
          req.config.xai.voiceId ??
          req.config.xai.voice ??
          DEFAULT_XAI_VOICE,
        responseFormat: outputFormat,
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: outputFormat === "opus" ? ".opus" : ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey = req.config.xai.apiKey || process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("xAI API key missing");
      }
      const audioBuffer = await openaiTTS({
        text: req.text,
        apiKey,
        baseUrl: normalizeBaseUrl(req.config.xai.baseUrl),
        model: req.config.xai.model ?? DEFAULT_XAI_MODEL,
        voice: req.config.xai.voiceId ?? req.config.xai.voice ?? DEFAULT_XAI_VOICE,
        responseFormat: "pcm",
        timeoutMs: req.config.timeoutMs,
      });
      return { audioBuffer, outputFormat: "pcm", sampleRate: 24_000 };
    },
  };
}
