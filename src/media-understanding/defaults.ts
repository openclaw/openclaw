import type { MediaUnderstandingCapability } from "./types.js";

const MB = 1024 * 1024;

export const DEFAULT_MAX_CHARS = 500;
export const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<
  MediaUnderstandingCapability,
  number | undefined
> = {
  image: DEFAULT_MAX_CHARS,
  audio: undefined,
  video: DEFAULT_MAX_CHARS,
};
export const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number> = {
  image: 10 * MB,
  audio: 20 * MB,
  video: 50 * MB,
};
export const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number> = {
  image: 60,
  audio: 60,
  video: 120,
};
export const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string> = {
  image: "Describe the image.",
  audio: "Transcribe the audio.",
  video: "Describe the video.",
};
export const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
export const DEFAULT_AUDIO_MODELS: Record<string, string> = {
  groq: "whisper-large-v3-turbo",
  openai: "gpt-4o-mini-transcribe",
  deepgram: "nova-3",
  assemblyai: "best",
};

export const AUTO_AUDIO_KEY_PROVIDERS = [
  "openai",
  "groq",
  "deepgram",
  "google",
  "assemblyai",
] as const;
export const AUTO_IMAGE_KEY_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "minimax",
  "zai",
] as const;
export const AUTO_VIDEO_KEY_PROVIDERS = ["google"] as const;
export const DEFAULT_IMAGE_MODELS: Record<string, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-opus-4-6",
  google: "gemini-3-flash-preview",
  minimax: "MiniMax-VL-01",
  zai: "glm-4.6v",
};
export const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
export const DEFAULT_MEDIA_CONCURRENCY = 2;
