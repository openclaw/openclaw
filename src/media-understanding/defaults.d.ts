import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";
export declare const DEFAULT_MAX_CHARS = 500;
export declare const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<MediaUnderstandingCapability, number | undefined>;
export declare const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number>;
export declare const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number>;
export declare const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string>;
export declare const DEFAULT_VIDEO_MAX_BASE64_BYTES: number;
export declare const CLI_OUTPUT_MAX_BUFFER: number;
export declare const DEFAULT_MEDIA_CONCURRENCY = 2;
export declare function resolveDefaultMediaModel(params: {
    providerId: string;
    capability: MediaUnderstandingCapability;
    cfg?: OpenClawConfig;
    providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string | undefined;
export declare function resolveAutoMediaKeyProviders(params: {
    capability: MediaUnderstandingCapability;
    cfg?: OpenClawConfig;
    providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): string[];
export declare function providerSupportsNativePdfDocument(params: {
    providerId: string;
    cfg?: OpenClawConfig;
    providerRegistry?: Map<string, MediaUnderstandingProvider>;
}): boolean;
/**
 * Minimum audio file size in bytes below which transcription is skipped.
 * Files smaller than this threshold are almost certainly empty or corrupt
 * and would cause unhelpful API errors from Whisper/transcription providers.
 */
export declare const MIN_AUDIO_FILE_BYTES = 1024;
