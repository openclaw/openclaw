/** Classifies model-provider request headers that should be treated as credential material. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Substring matching catches provider-specific auth headers without forcing every plugin to
// register its own spelling in the shared plaintext-secret audit.
const SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
];

/**
 * Returns whether a model-provider header name should be treated as secret-bearing.
 * This is intentionally conservative: false positives are audit noise, false negatives leak keys.
 */
export function isLikelySensitiveModelProviderHeaderName(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    SENSITIVE_MODEL_PROVIDER_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}
