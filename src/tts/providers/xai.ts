import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { XAI_TTS_VOICES, isValidXaiVoice } from "../tts-core.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export type XaiTtsOutputFormat = "mp3" | "wav" | "pcm" | "g711_alaw" | "g711_ulaw";

async function xaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voice: string;
  model?: string;
  language?: string;
  speed?: number;
  outputFormat: XaiTtsOutputFormat;
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voice,
    model,
    language,
    speed,
    outputFormat,
    sampleRate,
    timeoutMs,
  } = params;

  if (!isValidXaiVoice(voice)) {
    throw new Error(`Invalid xAI TTS voice: ${voice}. Valid voices: ${XAI_TTS_VOICES.join(", ")}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        ...(model && { model }),
        voice_id: voice,
        ...(language && { language }),
        ...(speed != null && { speed }),
        output_format: outputFormat,
        ...(sampleRate != null && { sample_rate: sampleRate }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`xAI TTS API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

function inferXaiExtension(format: XaiTtsOutputFormat): string {
  switch (format) {
    case "mp3":
      return ".mp3";
    case "wav":
      return ".wav";
    case "pcm":
      return ".pcm";
    case "g711_alaw":
      return ".alaw";
    case "g711_ulaw":
      return ".ulaw";
  }
}

export function buildXaiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "xai",
    label: "xAI",
    voices: [...XAI_TTS_VOICES],
    listVoices: async () => XAI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ config }) => Boolean(config.xai?.apiKey || process.env.XAI_API_KEY),
    synthesize: async (req) => {
      const apiKey = req.config.xai.apiKey || process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("xAI API key missing");
      }
      const baseUrl = (req.config.xai.baseUrl || DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
      const outputFormat: XaiTtsOutputFormat =
        req.target === "voice-note" ? "pcm" : (req.config.xai.outputFormat ?? "mp3");
      const audioBuffer = await xaiTTS({
        text: req.text,
        apiKey,
        baseUrl,
        voice: req.overrides?.xai?.voice ?? req.config.xai.voice,
        model: req.overrides?.xai?.model ?? req.config.xai.model,
        language: req.config.xai.language,
        speed: req.config.xai.speed,
        outputFormat,
        sampleRate: req.config.xai.sampleRate,
        timeoutMs: req.config.timeoutMs,
      });
      return {
        audioBuffer,
        outputFormat,
        fileExtension: inferXaiExtension(outputFormat),
        voiceCompatible: req.target === "voice-note",
      };
    },
    synthesizeTelephony: async (req) => {
      const apiKey = req.config.xai.apiKey || process.env.XAI_API_KEY;
      if (!apiKey) {
        throw new Error("xAI API key missing");
      }
      const baseUrl = (req.config.xai.baseUrl || DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
      const outputFormat: XaiTtsOutputFormat = "pcm";
      const sampleRate = req.config.xai.sampleRate ?? 16_000;
      const audioBuffer = await xaiTTS({
        text: req.text,
        apiKey,
        baseUrl,
        voice: req.config.xai.voice,
        model: req.config.xai.model,
        language: req.config.xai.language,
        speed: req.config.xai.speed,
        outputFormat,
        sampleRate,
        timeoutMs: req.config.timeoutMs,
      });
      return { audioBuffer, outputFormat, sampleRate };
    },
  };
}
