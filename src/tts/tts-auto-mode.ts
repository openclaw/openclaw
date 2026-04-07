import type { TtsAutoMode } from "../config/types.tts.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const TTS_AUTO_MODES = new Set<TtsAutoMode>(["off", "always", "inbound", "tagged"]);

export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (TTS_AUTO_MODES.has(normalized as TtsAutoMode)) {
    return normalized as TtsAutoMode;
  }
  return undefined;
}
