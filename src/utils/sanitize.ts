/**
 * Sanitize user-provided text to prevent log injection and other attacks.
 * Removes control characters, limits length, prevents log forgery.
 */
export function sanitizeUserText(text: string | undefined, maxLength = 256): string | undefined {
  if (!text) {
    return undefined;
  }

  // Remove control characters (including newlines, tabs, etc.)
  // Keep only printable ASCII + common Unicode
  let sanitized = text.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length to prevent memory exhaustion
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + '...';
  }
  
  return sanitized.length > 0 ? sanitized : undefined;
}
