/**
 * Inworld TTS Provider for OpenClaw
 *
 * Integrates Inworld AI's Text-to-Speech service as a provider option.
 * Supports 65 voices across 15 languages with low latency (~130-250ms).
 *
 * @see https://docs.inworld.ai/docs/tts/tts
 * @author Willsingh Wilson <w.wilson@w-a-x.com>
 * @license MIT
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

/** Inworld TTS configuration options */
export interface InworldTtsConfig {
  /** API key (Base64 encoded). Falls back to INWORLD_API_KEY env var */
  apiKey?: string;
  /** Voice ID to use (e.g., "Dennis", "Pixie", "Johanna") */
  voiceId?: string;
  /** Model variant: standard (faster, cheaper) or max (higher quality) */
  modelId?: "inworld-tts-1" | "inworld-tts-1-max";
  /** Output audio format */
  outputFormat?: "mp3" | "wav" | "opus";
  /** Optional timestamp alignment for subtitles/lipsync */
  timestampType?: "WORD" | "CHARACTER" | "PHONEME" | "VISEME";
}

/** Result returned by the TTS provider */
export interface TtsResult {
  success: boolean;
  audioPath?: string;
  error?: string;
  latencyMs?: number;
  provider: string;
}

/** Inworld API response structure */
interface InworldApiResponse {
  audioContent?: string;
  error?: string;
  message?: string;
}

// ============================================================================
// Constants
// ============================================================================

const INWORLD_API_BASE = "https://api.inworld.ai/tts/v1";
const DEFAULT_VOICE = "Dennis";
const DEFAULT_MODEL = "inworld-tts-1";
const DEFAULT_FORMAT = "opus";

/** All available voice IDs for validation */
export const INWORLD_VOICE_IDS = [
  // English (25)
  "Alex",
  "Ashley",
  "Blake",
  "Carter",
  "Clive",
  "Craig",
  "Deborah",
  "Dennis",
  "Dominus",
  "Edward",
  "Elizabeth",
  "Hades",
  "Hana",
  "Julia",
  "Luna",
  "Mark",
  "Olivia",
  "Pixie",
  "Priya",
  "Ronald",
  "Sarah",
  "Shaun",
  "Theodore",
  "Timothy",
  "Wendy",
  // German (2)
  "Johanna",
  "Josef",
  // Chinese (4)
  "Jing",
  "Xiaoyin",
  "Xinyi",
  "Yichen",
  // Dutch (4)
  "Erik",
  "Katrien",
  "Lennart",
  "Lore",
  // French (4)
  "Alain",
  "Étienne",
  "Hélène",
  "Mathieu",
  // Italian (2)
  "Gianni",
  "Orietta",
  // Japanese (2)
  "Asuka",
  "Satoshi",
  // Korean (4)
  "Hyunwoo",
  "Minji",
  "Seojun",
  "Yoona",
  // Polish (2)
  "Szymon",
  "Wojciech",
  // Portuguese (2)
  "Heitor",
  "Maitê",
  // Spanish (4)
  "Diego",
  "Lupita",
  "Miguel",
  "Rafael",
  // Russian (4)
  "Dmitry",
  "Elena",
  "Nikolai",
  "Svetlana",
  // Hindi (2)
  "Manoj",
  "Riya",
  // Hebrew (2)
  "Oren",
  "Yael",
  // Arabic (2)
  "Nour",
  "Omar",
] as const;

export const INWORLD_MODELS = ["inworld-tts-1", "inworld-tts-1-max"] as const;

/** Type for valid model IDs */
type InworldModelId = (typeof INWORLD_MODELS)[number];

/** Type guard for model validation */
function isValidModel(model: string): model is InworldModelId {
  return INWORLD_MODELS.includes(model as InworldModelId);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolves the Inworld API key from config or environment variables.
 */
function resolveApiKey(config: InworldTtsConfig): string | undefined {
  return config.apiKey ?? process.env.INWORLD_API_KEY ?? process.env.INWORLD_TTS_API_KEY;
}

/**
 * Gets the file extension for the output format.
 * Telegram requires .ogg extension for opus voice notes.
 */
function getFileExtension(format: string): string {
  return format === "opus" ? ".ogg" : `.${format}`;
}

/**
 * Validates and normalizes the voice ID (case-insensitive).
 */
function normalizeVoiceId(voiceId: string | undefined): string {
  if (!voiceId) {
    return DEFAULT_VOICE;
  }

  // Case-insensitive voice lookup
  const normalizedVoice = INWORLD_VOICE_IDS.find((v) => v.toLowerCase() === voiceId.toLowerCase());

  if (normalizedVoice) {
    return normalizedVoice;
  }

  console.warn(`[tts] [inworld] Unknown voice "${voiceId}", proceeding anyway`);
  return voiceId;
}

/**
 * Validates and normalizes the model ID.
 */
function normalizeModelId(modelId: string | undefined): string {
  const model = modelId ?? DEFAULT_MODEL;
  if (!isValidModel(model)) {
    throw new Error(`Invalid model: ${model}. Valid options: ${INWORLD_MODELS.join(", ")}`);
  }
  return model;
}

// ============================================================================
// Main Provider Function
// ============================================================================

/**
 * Converts text to speech using Inworld AI's TTS API.
 *
 * @param text - The text to convert to speech
 * @param config - Inworld TTS configuration
 * @returns TtsResult with audio file path or error details
 *
 * @example
 * ```typescript
 * const result = await inworldTTS("Hello world", {
 *   inworld: { voiceId: "Dennis", modelId: "inworld-tts-1" }
 * });
 * if (result.success) {
 *   console.log("Audio saved to:", result.audioPath);
 * }
 * ```
 */
export async function inworldTTS(
  text: string,
  config: { inworld?: InworldTtsConfig },
): Promise<TtsResult> {
  const startTime = Date.now();
  const inworldConfig = config.inworld ?? {};

  // Validate API key
  const apiKey = resolveApiKey(inworldConfig);
  if (!apiKey) {
    return {
      success: false,
      error:
        "Inworld API key not configured. Set INWORLD_API_KEY environment variable or config.inworld.apiKey",
      provider: "inworld",
    };
  }

  // Validate and normalize parameters
  const voiceId = normalizeVoiceId(inworldConfig.voiceId);
  let modelId: string;
  try {
    modelId = normalizeModelId(inworldConfig.modelId);
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      provider: "inworld",
    };
  }
  const outputFormat = inworldConfig.outputFormat ?? DEFAULT_FORMAT;

  try {
    // Build request payload
    const payload: Record<string, unknown> = {
      text,
      voiceId,
      modelId,
      outputFormat: outputFormat.toUpperCase(),
    };

    if (inworldConfig.timestampType) {
      payload.timestampType = inworldConfig.timestampType;
    }

    // Make API request
    const response = await fetch(`${INWORLD_API_BASE}/voice`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Handle HTTP errors
    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Inworld API error (${response.status})`;

      try {
        const errorJson = JSON.parse(errorText) as InworldApiResponse;
        errorMessage = errorJson.message ?? errorJson.error ?? errorMessage;
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }

      // Provide user-friendly messages for common errors
      const errorMessages: Record<number, string> = {
        401: "Inworld API key is invalid or expired",
        402: "Inworld quota exceeded - please check your billing",
        429: "Inworld rate limit exceeded - please try again later",
        400: `Bad request: ${errorMessage}`,
      };

      return {
        success: false,
        error: errorMessages[response.status] ?? errorMessage,
        provider: "inworld",
        latencyMs: Date.now() - startTime,
      };
    }

    // Parse JSON response with base64-encoded audio
    const responseData = (await response.json()) as InworldApiResponse;

    if (!responseData.audioContent) {
      return {
        success: false,
        error: responseData.error ?? "Inworld API returned no audio content",
        provider: "inworld",
        latencyMs: Date.now() - startTime,
      };
    }

    // Decode base64 audio
    const audioBuffer = Buffer.from(responseData.audioContent, "base64");

    if (audioBuffer.byteLength === 0) {
      return {
        success: false,
        error: "Inworld returned empty audio data",
        provider: "inworld",
        latencyMs: Date.now() - startTime,
      };
    }

    // Save audio file
    const tempDir = join(tmpdir(), "openclaw-tts");
    await mkdir(tempDir, { recursive: true });

    const filename = `inworld-${randomUUID()}${getFileExtension(outputFormat)}`;
    const audioPath = join(tempDir, filename);

    await writeFile(audioPath, audioBuffer);

    const latencyMs = Date.now() - startTime;
    console.log(
      `[tts] [inworld] Generated ${audioBuffer.byteLength} bytes in ${latencyMs}ms (voice: ${voiceId})`,
    );

    return {
      success: true,
      audioPath,
      provider: "inworld",
      latencyMs,
    };
  } catch (error: unknown) {
    const err = error as Error & { code?: string };
    let errorMessage = err.message ?? "Unknown error";

    // Handle network errors
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      errorMessage = "Cannot reach Inworld API - please check your internet connection";
    } else if (err.code === "ETIMEDOUT") {
      errorMessage = "Inworld API request timed out";
    }

    return {
      success: false,
      error: errorMessage,
      provider: "inworld",
      latencyMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

export default inworldTTS;
