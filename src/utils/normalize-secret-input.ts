/**
 * Normalizes a raw secret value from config, env, setup prompts, or plugin SDK callers.
 * Returns an empty string for absent/invalid input so callers can keep boolean presence checks simple.
 */
export function normalizeSecretInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  // Keep printable Latin-1 for HTTP ByteString headers, including internal spaces
  // in values such as "Bearer <token>". Drop controls and rich-text paste artifacts.
  return value.replace(/[^\u0020-\u007e\u00a0-\u00ff]/gu, "").trim();
}

/**
 * Normalizes a raw secret value and converts empty normalized output to `undefined`.
 * Use this at optional config boundaries where "not configured" is clearer than an empty string.
 */
export function normalizeOptionalSecretInput(value: unknown): string | undefined {
  const normalized = normalizeSecretInput(value);
  return normalized || undefined;
}
