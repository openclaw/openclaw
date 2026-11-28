// Validates executable config values before they reach shell-adjacent paths.
const SHELL_METACHARS = /[;&|`$<>]/;
const CONTROL_CHARS = /[\r\n]/;
const QUOTE_CHARS = /["']/;
const BARE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;

function isLikelyPath(value: string): boolean {
  return (
    value.startsWith(".") || value.startsWith("~") || value.includes("/") || value.includes("\\")
  );
}

/** Validates that a configured executable value cannot smuggle shell syntax. */
export function isSafeExecutableValue(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    CONTROL_CHARS.test(trimmed) ||
    SHELL_METACHARS.test(trimmed) ||
    QUOTE_CHARS.test(trimmed)
  ) {
    return false;
  }

  // Path-like executables may contain separators, but still reject shell syntax above.
  if (isLikelyPath(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("-")) {
    return false;
  }
  return BARE_NAME_PATTERN.test(trimmed);
}
