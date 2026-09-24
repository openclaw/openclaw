// Device metadata normalization for auth payloads and policy matching.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

/** Normalize device metadata for policy classification. */
export function normalizeDeviceMetadataForPolicy(value?: string | null): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "";
  }
  // Policy classification should collapse Unicode confusables to stable ASCII-ish
  // tokens where possible before matching platform/family rules.
  return normalizeLowercaseStringOrEmpty(trimmed.normalize("NFKD").replace(/\p{M}/gu, ""));
}
