import { rmSync } from "node:fs";

export type { SpeechProviderPlugin } from "../../plugins/types.js";
export type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechListVoicesRequest,
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderConfiguredContext,
  SpeechProviderResolveConfigContext,
  SpeechProviderResolveTalkConfigContext,
  SpeechProviderResolveTalkOverridesContext,
  SpeechProviderOverrides,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
  SpeechVoiceOption,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "../../tts/provider-types.js";

const TEMP_FILE_CLEANUP_DELAY_MS = 5 * 60 * 1000;

export function requireInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

export function normalizeLanguageCode(code?: string): string | undefined {
  const trimmed = code?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new Error("languageCode must be a 2-letter ISO 639-1 code (e.g. en, de, fr)");
  }
  return normalized;
}

export function normalizeApplyTextNormalization(mode?: string): "auto" | "on" | "off" | undefined {
  const trimmed = mode?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || normalized === "on" || normalized === "off") {
    return normalized;
  }
  throw new Error("applyTextNormalization must be one of: auto, on, off");
}

export function normalizeSeed(seed?: number): number | undefined {
  if (seed == null) {
    return undefined;
  }
  const next = Math.floor(seed);
  if (!Number.isFinite(next) || next < 0 || next > 4_294_967_295) {
    throw new Error("seed must be between 0 and 4294967295");
  }
  return next;
}

export function scheduleCleanup(
  tempDir: string,
  delayMs: number = TEMP_FILE_CLEANUP_DELAY_MS,
): void {
  const timer = setTimeout(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }, delayMs);
  timer.unref();
}

export async function summarizeText(): Promise<never> {
  throw new Error("summarizeText is unavailable in the Vitest capability contract shim");
}
