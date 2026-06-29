/**
 * Helper functions for tool card rendering.
 */

import { isMarkdownBlockArtText } from "../markdown.ts";
import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

/**
 * Format tool output content for display in the sidebar.
 * Detects block art and JSON, wrapping content in code blocks when needed.
 */
export function formatToolOutputForSidebar(text: string): string {
  if (isMarkdownBlockArtText(text)) {
    return "```\n" + text + "\n```";
  }

  const trimmed = text.trim();
  // Try to detect and format JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      // Not valid JSON, return as-is
    }
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
