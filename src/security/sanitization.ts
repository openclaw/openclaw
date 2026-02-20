/**
 * Security sanitization for user inputs.
 */

/**
 * Sanitizes input to prevent common prompt injection patterns.
 * This is a basic layer of defense.
 */
export function sanitizePrompt(input: string): string {
  if (typeof input !== "string") {
    return "";
  }

  // Normalize line endings
  let sanitized = input.replace(/\r\n/g, "\n");

  // Basic guard against suspicious control characters that could be used for bypass
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");

  // Flag or minimize common injection keywords if they look suspicious (e.g. at the start of a line after a separator)
  // For now we just return the cleaned string.

  return sanitized;
}

/**
 * Sanitizes input for XSS prevention.
 */
export function sanitizeXSS(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Sanitizes input for SQL injection prevention.
 * Note: Parameterized queries are always preferred.
 */
export function sanitizeSQL(input: string): string {
  if (typeof input !== "string") {
    return "";
  }
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\0\x08\x09\x1a\n\r"'\\%]/g, (char) => {
    switch (char) {
      case "\0":
        return "\\0";
      case "\x08":
        return "\\b";
      case "\x09":
        return "\\t";
      case "\x1a":
        return "\\z";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case '"':
      case "'":
      case "\\":
      case "%":
        return "\\" + char;
      default:
        return char;
    }
  });
}

/**
 * Combined sanitization for chat inputs.
 */
export function sanitizeChatInput(input: string): string {
  let result = input;
  result = sanitizePrompt(result);
  // We apply XSS sanitization as a default for all text and content.
  result = sanitizeXSS(result);
  // Add SQL sanitization as an additional safety layer.
  result = sanitizeSQL(result);
  return result;
}
