// TTS auto mode helpers decide when speech should be generated automatically.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { TtsAutoMode } from "../config/types.tts.js";
import { TtsAutoSchema } from "../config/zod-schema.core.js";

/** Accepted TTS auto modes from config, prefs, and session-level overrides. */
export const TTS_AUTO_MODES = new Set<TtsAutoMode>(TtsAutoSchema.options);

function isTtsAutoMode(value: string): value is TtsAutoMode {
  return TtsAutoSchema.safeParse(value).success;
}

/** Normalize an unknown value into a supported TTS auto mode. */
export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized && isTtsAutoMode(normalized)) {
    return normalized;
  }
  return undefined;
}
