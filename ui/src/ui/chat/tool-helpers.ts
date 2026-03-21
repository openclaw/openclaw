/**
 * Helper functions for tool card rendering.
 */

import { looksLikeHalfBlockArt } from "../markdown.ts";
import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and wraps it in a code block with formatting.
 * Detects half-block art (QR codes) and wraps in a code fence so
 * the markdown renderer can apply tight-tiling styles.
 */
export function formatToolOutputForSidebar(text: string): string {
  const trimmed = text.trim();
  // Try to detect and format JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      // Not valid JSON, fall through
    }
  }
  // Half-block art (QR codes, box-drawing) needs a code fence so the
  // markdown renderer wraps it with .half-block-art styling.
  if (looksLikeHalfBlockArt(trimmed)) {
    // Use original text (not trimmed) to preserve QR quiet-zone padding
    // that scanners need around the edges.
    return "```\n" + text + "\n```";
  }
  return text;
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
