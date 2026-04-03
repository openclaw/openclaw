/**
 * Sanitize user-provided text to prevent log injection and other attacks.
 * Removes control characters, limits length, prevents log forgery.
 */
function truncateWithoutSplittingSurrogatePair(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  let cutAt = maxLength;
  const code = value.charCodeAt(cutAt - 1);
  // If we would cut right after a high surrogate, step back one code unit.
  if (code >= 0xd800 && code <= 0xdbff) {
    cutAt -= 1;
  }

  return value.substring(0, cutAt);
}

export function sanitizeUserText(text: string | undefined, maxLength = 256): string | undefined {
  if (!text) {
    return undefined;
  }

  // Remove control characters (including newlines, tabs, etc.)
  // Keep only printable ASCII + common Unicode
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length to prevent memory exhaustion and avoid splitting UTF-16 surrogate pairs.
  if (sanitized.length > maxLength) {
    sanitized = truncateWithoutSplittingSurrogatePair(sanitized, maxLength) + "...";
  }

  return sanitized.length > 0 ? sanitized : undefined;
}
