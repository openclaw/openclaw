/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES, TOOL_INLINE_THRESHOLD } from "./constants.js";

/**
 * Format tool output content for display in the sidebar.
 * Truncates long outputs and shows a preview.
 *
 * @param output - The tool output to format
 * @param maxLength - Maximum characters to show (default: PREVIEW_MAX_CHARS)
 * @returns Formatted output with truncation indicator if needed
 */
export function formatToolOutput(output: string, maxLength: number = PREVIEW_MAX_CHARS): string {
  if (!output || output.length <= maxLength) {
    return output;
  }

  return output.slice(0, maxLength) + "...";
}

/**
 * Get truncated preview of tool output.
 *
 * @param text - The full tool output text
 * @param maxLines - Maximum number of lines to show (default: PREVIEW_MAX_LINES)
 * @returns Truncated preview with line count indicator
 */
export function getTruncatedPreview(text: string, maxLines: number = PREVIEW_MAX_LINES): string {
  if (!text) {
    return "";
  }

  const lines = text.split("\n");

  if (lines.length <= maxLines) {
    return text;
  }

  return lines.slice(0, maxLines).join("\n") + `... (${lines.length - maxLines} more lines)`;
}

/**
 * Check if tool output is long enough to need truncation.
 *
 * @param text - The tool output text
 * @returns True if output exceeds TOOL_INLINE_THRESHOLD
 */
export function isLongToolOutput(text: string): boolean {
  return text.length > TOOL_INLINE_THRESHOLD;
}
