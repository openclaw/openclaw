import { normalizeE164 } from "../utils.js";

/**
 * Normalizes a LINQ messaging target handle.
 * LINQ uses E.164 phone numbers and email addresses.
 */
export function normalizeLinqHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = trimmed.toLowerCase();

  // Strip linq: prefix
  if (lowered.startsWith("linq:")) {
    return normalizeLinqHandle(trimmed.slice(5));
  }

  // Email handle
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }

  // E.164 phone number
  const normalized = normalizeE164(trimmed);
  if (normalized) {
    return normalized;
  }

  // Return cleaned up
  return trimmed.replace(/\s+/g, "");
}
