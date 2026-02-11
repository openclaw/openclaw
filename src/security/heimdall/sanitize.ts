/**
 * Heimdall Security Layer — Input Sanitization
 *
 * Deterministic input sanitization pipeline:
 *   1. Truncate to maxLength
 *   2. NFKC unicode normalization
 *   3. Control character density check & stripping
 */

import type { SanitizeConfig, SanitizeResult, SanitizeWarning } from "./types.js";

const DEFAULT_MAX_LENGTH = 100_000;
const DEFAULT_CONTROL_CHAR_DENSITY_THRESHOLD = 0.1;

// Control chars: U+0000-U+001F (excluding \t=0x09, \n=0x0A, \r=0x0D), plus U+007F-U+009F
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function sanitizeInput(text: string, config?: SanitizeConfig): SanitizeResult {
  const warnings: SanitizeWarning[] = [];
  let result = text;

  // 1. Truncate if exceeding maxLength
  const maxLength = config?.maxLength ?? DEFAULT_MAX_LENGTH;
  if (result.length > maxLength) {
    result = result.slice(0, maxLength);
    warnings.push({
      type: "truncated",
      detail: `Input truncated from ${text.length} to ${maxLength} characters`,
    });
  }

  // 2. NFKC normalization
  const shouldNormalize = config?.nfkcNormalize !== false;
  if (shouldNormalize) {
    const normalized = result.normalize("NFKC");
    if (normalized !== result) {
      result = normalized;
      warnings.push({ type: "normalized", detail: "NFKC unicode normalization applied" });
    }
  }

  // 3. Control character density check
  const densityThreshold =
    config?.controlCharDensityThreshold ?? DEFAULT_CONTROL_CHAR_DENSITY_THRESHOLD;
  if (result.length > 0) {
    const controlChars = result.match(CONTROL_CHAR_RE);
    const density = (controlChars?.length ?? 0) / result.length;
    if (density > densityThreshold) {
      result = result.replace(CONTROL_CHAR_RE, "");
      warnings.push({
        type: "control_chars_stripped",
        detail: `Stripped control characters (density ${(density * 100).toFixed(1)}% exceeded ${(densityThreshold * 100).toFixed(1)}% threshold)`,
      });
    }
  }

  return { text: result, warnings };
}
