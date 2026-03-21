import type { SpeechProviderPlugin } from "../../plugins/types.js";

const GEMINI_TTS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
  "Perseus",
] as const;

export function buildGeminiSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "gemini",
    label: "Google Gemini",
    aliases: ["google"],
    voices: GEMINI_TTS_VOICES as unknown as readonly string[],
    listVoices: async () => GEMINI_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ config }) =>
      Boolean(config.gemini.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY),
    synthesize: async (req) => {
      const apiKey =
        req.config.gemini.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("Google/Gemini API key missing");
      }

      const model = req.overrides?.gemini?.model ?? req.config.gemini.model;
      const voice = req.overrides?.gemini?.voice ?? req.config.gemini.voice;
      const instructions = req.config.gemini.instructions;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), req.config.timeoutMs);

      try {
        const response = await fetch(
          `${GEMINI_TTS_BASE_URL}/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [{ text: req.text }],
                },
              ],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                  },
                  ...(instructions ? { systemInstructions: instructions } : {}),
                },
              },
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Gemini TTS failed (${response.status}): ${body}`);
        }

        const json = (await response.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: { mimeType?: string; data?: string };
              }>;
            };
          }>;
        };

        const inlineData = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
        if (!inlineData?.data) {
          throw new Error("Gemini TTS returned no audio data");
        }

        // Gemini returns base64-encoded audio; default is audio/L16 (PCM) at 24kHz.
        // We return the raw buffer and let the caller handle format.
        const audioBuffer = Buffer.from(inlineData.data, "base64");
        const mimeType = inlineData.mimeType ?? "audio/L16";

        // Gemini returns PCM (L16) by default; convert info for downstream.
        const isWav = mimeType.includes("wav");
        const isMp3 = mimeType.includes("mp3") || mimeType.includes("mpeg");

        return {
          audioBuffer,
          outputFormat: isMp3 ? "mp3" : isWav ? "wav" : "pcm",
          fileExtension: isMp3 ? ".mp3" : isWav ? ".wav" : ".pcm",
          voiceCompatible: true,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
