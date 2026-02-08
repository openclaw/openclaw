/**
 * Upload configuration constants
 */

/** Maximum upload size: 50MB */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** Upload TTL: 24 hours */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Blocked executable extensions for security */
export const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".sh",
  ".bat",
  ".ps1",
  ".cmd",
  ".com",
  ".msi",
  ".scr",
  ".vbs",
  ".vbe",
  ".js", // server-side script
  ".jse",
  ".wsf",
  ".wsh",
]);

/** Check if extension is blocked */
export function isBlockedExtension(ext: string): boolean {
  return BLOCKED_EXTENSIONS.has(ext.toLowerCase());
}
