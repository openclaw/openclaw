import path from "node:path";

/**
 * Validates if the string is a valid E.164 phone number.
 * Must start with + and contain 7-15 digits.
 */
export function isValidE164(input: string): boolean {
  if (!input.startsWith("+")) {
    return false;
  }
  const digits = input.slice(1);
  if (!/^\d+$/.test(digits)) {
    return false;
  }
  if (digits.length < 7 || digits.length > 15) {
    return false;
  }
  return true;
}

/**
 * Sanitizes a filename to prevent directory traversal and invalid characters.
 * Replaces risky characters with underscores.
 */
export function sanitizeFilename(filename: string): string {
  // Remove directory separators
  const base = path.basename(filename);
  // Allow alphanumeric, dot, dash, underscore. Replace others.
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Checks if a path segment attempts traversal.
 */
export function hasPathTraversal(input: string): boolean {
  return input.includes("..") || input.includes("/") || input.includes("\\");
}
