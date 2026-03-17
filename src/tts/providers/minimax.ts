import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { MINIMAX_TTS_MODELS, MINIMAX_TTS_VOICES, minimaxTTS } from "../tts-core.js";

export function buildMinimaxSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    models: MINIMAX_TTS_MODELS,
    voices: MINIMAX_TTS_VOICES,
    listVoices: async () => MINIMAX_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ config }) => Boolean(config.minimax?.apiKey || process.env.MINIMAX_API_KEY),
    synthesize: async (req) => {
      const apiKey = req.config.minimax?.apiKey || process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.minimax?.baseUrl ?? "https://api.minimax.io",
        model: req.overrides?.minimax?.model ?? req.config.minimax?.model ?? "speech-2.8-hd",
        voiceId:
          req.overrides?.minimax?.voiceId ??
          req.config.minimax?.voiceId ??
          "English_expressive_narrator",
        audioFormat: "mp3",
        sampleRate: 32_000,
        speed: req.overrides?.minimax?.speed ?? req.config.minimax?.speed,
        vol: req.overrides?.minimax?.vol ?? req.config.minimax?.vol,
        pitch: req.overrides?.minimax?.pitch ?? req.config.minimax?.pitch,
        emotion: req.overrides?.minimax?.emotion ?? req.config.minimax?.emotion,
        languageBoost: req.overrides?.minimax?.languageBoost ?? req.config.minimax?.languageBoost,
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey = req.config.minimax?.apiKey || process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const outputFormat = "pcm";
      const sampleRate = 24_000;
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.minimax?.baseUrl ?? "https://api.minimax.io",
        model: req.config.minimax?.model ?? "speech-2.8-hd",
        voiceId: req.config.minimax?.voiceId ?? "English_expressive_narrator",
        audioFormat: outputFormat,
        sampleRate,
        speed: req.config.minimax?.speed,
        vol: req.config.minimax?.vol,
        pitch: req.config.minimax?.pitch,
        emotion: req.config.minimax?.emotion,
        languageBoost: req.config.minimax?.languageBoost,
        timeoutMs: req.config.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
