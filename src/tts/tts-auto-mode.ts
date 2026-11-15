import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { TtsAutoMode } from "../config/types.tts.js";
import { TtsAutoSchema } from "../config/zod-schema.core.js";

/** Accepted TTS auto modes from config, prefs, and session-level overrides. */
export const TTS_AUTO_MODES = new Set<TtsAutoMode>(TtsAutoSchema.options);

export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  const parsed = TtsAutoSchema.safeParse(normalizeOptionalLowercaseString(value));
  return parsed.success ? parsed.data : undefined;
}
