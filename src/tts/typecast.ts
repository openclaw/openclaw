// Typecast TTS provider implementation.
// See https://typecast.ai/docs for API documentation.

export const DEFAULT_TYPECAST_BASE_HOST = "https://api.typecast.ai";
export const DEFAULT_TYPECAST_MODEL = "ssfm-v30" as const;
export const DEFAULT_TYPECAST_EMOTION_PRESET = "normal" as const;
export const DEFAULT_TYPECAST_EMOTION_INTENSITY = 1.0;

/** Resolved Typecast configuration (mirrors the typecast block in ResolvedTtsConfig). */
export type ResolvedTypecastConfig = {
  apiKey?: string;
  baseHost: string;
  voiceId?: string;
  model: "ssfm-v21" | "ssfm-v30";
  language?: string;
  emotionPreset: string;
  emotionIntensity: number;
  seed?: number;
  output: {
    volume: number;
    audioPitch: number;
    audioTempo: number;
    audioFormat: "wav" | "mp3";
  };
};

/** Resolve raw Typecast config into defaults-applied ResolvedTypecastConfig. */
export function resolveTypecastDefaults(raw?: {
  apiKey?: string;
  baseHost?: string;
  voiceId?: string;
  model?: string;
  language?: string;
  emotionPreset?: string;
  emotionIntensity?: number;
  seed?: number;
  output?: { volume?: number; audioPitch?: number; audioTempo?: number; audioFormat?: string };
}): ResolvedTypecastConfig {
  return {
    apiKey: raw?.apiKey,
    baseHost: raw?.baseHost?.trim() || DEFAULT_TYPECAST_BASE_HOST,
    voiceId: raw?.voiceId,
    model: (raw?.model as ResolvedTypecastConfig["model"]) ?? DEFAULT_TYPECAST_MODEL,
    language: raw?.language,
    emotionPreset: raw?.emotionPreset ?? DEFAULT_TYPECAST_EMOTION_PRESET,
    emotionIntensity: raw?.emotionIntensity ?? DEFAULT_TYPECAST_EMOTION_INTENSITY,
    seed: raw?.seed,
    output: {
      volume: raw?.output?.volume ?? 100,
      audioPitch: raw?.output?.audioPitch ?? 0,
      audioTempo: raw?.output?.audioTempo ?? 1.0,
      audioFormat: (raw?.output?.audioFormat as "wav" | "mp3") ?? "mp3",
    },
  };
}

/**
 * Build common call parameters for typecastTTS from resolved config.
 * Callers only need to supply text, apiKey, audioFormat override, and timeoutMs.
 */
export function buildTypecastCallParams(
  tc: ResolvedTypecastConfig,
  opts: { text: string; apiKey: string; audioFormat: "wav" | "mp3"; timeoutMs: number },
) {
  return {
    text: opts.text,
    apiKey: opts.apiKey,
    baseHost: tc.baseHost,
    voiceId: tc.voiceId,
    model: tc.model,
    language: tc.language,
    emotionPreset: tc.emotionPreset,
    emotionIntensity: tc.emotionIntensity,
    seed: tc.seed,
    output: { ...tc.output, audioFormat: opts.audioFormat },
    timeoutMs: opts.timeoutMs,
  };
}

/** High-level: synthesise via Typecast and return raw audio buffer. */
export async function callTypecast(
  tc: ResolvedTypecastConfig,
  text: string,
  apiKey: string,
  audioFormat: "wav" | "mp3",
  timeoutMs: number,
): Promise<Buffer> {
  return typecastTTS(buildTypecastCallParams(tc, { text, apiKey, audioFormat, timeoutMs }));
}

/** High-level: synthesise via Typecast for telephony (WAV) and return buffer + parsed sample rate. */
export async function callTypecastTelephony(
  tc: ResolvedTypecastConfig,
  text: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ audioBuffer: Buffer; sampleRate: number }> {
  const audioBuffer = await typecastTTS(
    buildTypecastCallParams(tc, { text, apiKey, audioFormat: "wav", timeoutMs }),
  );
  return { audioBuffer, sampleRate: parseWavSampleRate(audioBuffer) };
}

/** Parse sample rate from a WAV header (bytes 24–27, little-endian uint32). */
function parseWavSampleRate(buf: Buffer, fallback = 24000): number {
  if (
    buf.length >= 28 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46
  ) {
    return buf.readUInt32LE(24);
  }
  return fallback;
}

export async function typecastTTS(params: {
  text: string;
  apiKey: string;
  baseHost: string;
  voiceId?: string;
  model: "ssfm-v21" | "ssfm-v30";
  language?: string;
  emotionPreset: string;
  emotionIntensity: number;
  seed?: number;
  output: {
    volume: number;
    audioPitch: number;
    audioTempo: number;
    audioFormat: "wav" | "mp3";
  };
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseHost,
    voiceId,
    model,
    language,
    emotionPreset,
    emotionIntensity,
    seed,
    output,
    timeoutMs,
  } = params;

  if (!voiceId) {
    throw new Error("Typecast voiceId is required");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const normalizedBase = baseHost.replace(/\/+$/, "");
    const url = `${normalizedBase}/v1/text-to-speech`;

    const body: Record<string, unknown> = {
      text,
      voice_id: voiceId,
      model,
      prompt: {
        emotion_preset: emotionPreset,
        emotion_intensity: emotionIntensity,
      },
      output: {
        volume: output.volume,
        audio_pitch: output.audioPitch,
        audio_tempo: output.audioTempo,
        audio_format: output.audioFormat,
      },
    };

    if (language) {
      body.language = language;
    }
    if (seed !== undefined) {
      body.seed = seed;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
        Accept: `audio/${output.audioFormat}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Typecast API error (${response.status})`);
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}
