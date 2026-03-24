// Alphanumeric start, then letters/digits/hyphens/underscores; max 64 chars total. Keeps names path-safe and shell-friendly.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Returns true when `value` is non-empty and safe to use as a profile name in file paths and shell commands. */
export function isValidProfileName(value: string): boolean {
  if (!value) {
    return false;
  }
  // Keep it path-safe + shell-friendly.
  return PROFILE_NAME_RE.test(value);
}

/**
 * Normalizes a raw profile name from user input or an env var.
 * Returns null if the value is empty, the literal string "default" (which maps to the built-in default profile), or fails the name validation.
 */
export function normalizeProfileName(raw?: string | null): string | null {
  const profile = raw?.trim();
  if (!profile) {
    return null;
  }
  if (profile.toLowerCase() === "default") {
    return null;
  }
  if (!isValidProfileName(profile)) {
    return null;
  }
  return profile;
}
