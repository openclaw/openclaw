import type { ReplyPayload } from "../types.js";

/**
 * Parse LINE-specific directives from text and extract them into ReplyPayload fields.
 *
 * Stubbed: LINE channel modules have been removed. Returns payload unchanged.
 */
export function parseLineDirectives(payload: ReplyPayload): ReplyPayload {
  return payload;
}

/**
 * Check if text contains any LINE directives.
 *
 * Stubbed: LINE channel modules have been removed. Always returns false.
 */
export function hasLineDirectives(_text: string): boolean {
  return false;
}
