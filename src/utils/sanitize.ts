/**
 * Sanitize user-provided text to prevent log injection and other attacks.
 * Removes control characters, limits length, prevents log forgery.
 */
export function sanitizeUserText(text: string | undefined, maxLength = 256): string | undefined {
  if (!text) {
    return undefined;
  }

  // Remove control characters (including newlines, tabs, etc.)
  // Avoid regex here because lint rules flag control-character ranges.
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // C0 controls + DEL, plus C1 controls.
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue;
    }
    out += text[i];
  }

  // Trim whitespace
  let sanitized = out.trim();

  // Limit length to prevent memory exhaustion
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "...";
  }

  return sanitized.length > 0 ? sanitized : undefined;
}
