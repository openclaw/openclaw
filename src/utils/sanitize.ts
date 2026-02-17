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
  const chars: string[] = [];
  // Bound intermediate memory while preserving predictable sanitize -> trim -> cap semantics.
  const maxBufferLength = Math.max(maxLength + 1024, maxLength * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // C0 controls + DEL, plus C1 controls.
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue;
    }
    if (chars.length >= maxBufferLength) {
      break;
    }
    chars.push(text[i]);
  }

  // Trim whitespace
  const trimmed = chars.join("").trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
  }
  return trimmed;
}
