export const OPENAI_TTS_MODELS = [
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
  "tts-1",
  "tts-1-hd",
] as const;

export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "juniper",
  "marin",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

function sanitizeExtraBodyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    sanitized[key] = entry;
  }
  return sanitized;
}

/** Native OpenAI-style speech JSON; auth and endpoint selection remain caller-owned. */
export function buildOpenAiSpeechRequestBody(params: {
  model: string;
  text: string;
  voice: string;
  responseFormat: string;
  speed?: number;
  instructions?: string;
  extraBody?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    model: params.model,
    input: params.text,
    voice: params.voice,
    response_format: params.responseFormat,
    ...(params.speed == null ? {} : { speed: params.speed }),
    ...(params.instructions == null ? {} : { instructions: params.instructions }),
    ...(params.extraBody == null ? {} : sanitizeExtraBodyRecord(params.extraBody)),
  };
}
