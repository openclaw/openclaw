import type { SpeechProviderPlugin } from "../../plugins/types.js";
import type { SpeechVoiceOption } from "../provider-types.js";

const MINIMAX_TTS_MODELS = [
  "speech-01-turbo",
  "speech-01-hd",
  "speech-02-hd",
  "speech-02",
] as const;

// Popular MiniMax voice IDs
const MINIMAX_VOICE_IDS = [
  "female-shaonv",
  "male-baijia",
  "male-yunyang",
  "female-tianmei",
  "male-john",
  "female-emma",
] as const;

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimaxi.com";
const DEFAULT_MINIMAX_MODEL = "speech-01-turbo";
const DEFAULT_MINIMAX_VOICE = "female-shaonv";

function normalizeMiniMaxBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_MINIMAX_BASE_URL;
}

export async function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voiceId?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  timeoutMs?: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    model = DEFAULT_MINIMAX_MODEL,
    voiceId = DEFAULT_MINIMAX_VOICE,
    speed = 1.0,
    volume = 1.0,
    pitch = 0,
    timeoutMs = 30_000,
  } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizeMiniMaxBaseUrl(baseUrl)}/v1/t2a_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        text,
        voice_setting: {
          voice_id: voiceId,
          speed: Math.round(speed * 100) / 100,
          vol: Math.round(volume * 100) / 100,
          pitch,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error");
      throw new Error(`MiniMax TTS API error (${response.status}): ${error}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export async function listMiniMaxVoices(): Promise<SpeechVoiceOption[]> {
  // MiniMax doesn't have a public list voices API, so we return common voices
  // Users can use custom voice IDs from their MiniMax dashboard
  return MINIMAX_VOICE_IDS.map((voiceId) => ({
    id: voiceId,
    name: voiceId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  }));
}

export function buildMiniMaxSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax",
    models: MINIMAX_TTS_MODELS,
    listVoices: async (_req) => {
      return listMiniMaxVoices();
    },
    isConfigured: ({ config }) =>
      Boolean(config.minimax?.apiKey || process.env.MINIMAX_API_KEY),
    synthesize: async (req) => {
      const apiKey =
        req.config.minimax?.apiKey || process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.minimax?.baseUrl,
        model: req.config.minimax?.model ?? DEFAULT_MINIMAX_MODEL,
        voiceId: req.config.minimax?.voiceId ?? DEFAULT_MINIMAX_VOICE,
        speed: req.config.minimax?.speed,
        volume: req.config.minimax?.volume,
        pitch: req.config.minimax?.pitch,
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      // MiniMax doesn't natively support telephony formats
      // For Discord voice, we'd need to convert MP3 to PCM/Opus
      // This is handled by the voice-call extension's audio pipeline
      const apiKey =
        req.config.minimax?.apiKey || process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        throw new Error("MiniMax API key missing");
      }
      const audioBuffer = await minimaxTTS({
        text: req.text,
        apiKey,
        baseUrl: req.config.minimax?.baseUrl,
        model: req.config.minimax?.model ?? DEFAULT_MINIMAX_MODEL,
        voiceId: req.config.minimax?.voiceId ?? DEFAULT_MINIMAX_VOICE,
        speed: req.config.minimax?.speed,
        volume: req.config.minimax?.volume,
        pitch: req.config.minimax?.pitch,
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat: "mp3",
        sampleRate: 24000, // MiniMax default sample rate
      };
    },
  };
}
