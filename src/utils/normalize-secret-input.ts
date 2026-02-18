/**
 * Secret normalization for copy/pasted credentials.
 *
 * Common footgun: line breaks (especially `\r`) embedded in API keys/tokens.
 * We strip line breaks anywhere, then trim whitespace at the ends.
 *
 * Intentionally does NOT remove ordinary spaces inside the string to avoid
 * silently altering "Bearer <token>" style values.
 */
export function normalizeSecretInput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\r\n\u2028\u2029]+/g, "").trim();
}

export function normalizeOptionalSecretInput(value: unknown): string | undefined {
  const normalized = normalizeSecretInput(value);
  return normalized ? normalized : undefined;
}

/**
 * Resolve a secret by checking the secret store first, then falling back to
 * environment variables. Returns null if not found in either location.
 *
 * Uses dynamic import() to avoid circular dependency and to stay ESM-compatible.
 *
 * @param key - The secret key (e.g., "OPENAI_API_KEY")
 */
export async function resolveSecret(key: string): Promise<string | null> {
  try {
    const { getGlobalSecretStore } = await import("../security/secret-store.js");
    const store = getGlobalSecretStore();
    const value = store.get(key);
    if (value) {
      return normalizeSecretInput(value);
    }
  } catch {
    // Secret store not available, fall through to env
  }

  const envValue = process.env[key];
  if (envValue) {
    return normalizeSecretInput(envValue);
  }

  return null;
}

/**
 * Synchronous variant of resolveSecret that only checks environment variables.
 * Use this when async is not possible; prefer resolveSecret() for full secret store support.
 */
export function resolveSecretSync(key: string): string | null {
  const envValue = process.env[key];
  if (envValue) {
    return normalizeSecretInput(envValue);
  }
  return null;
}
