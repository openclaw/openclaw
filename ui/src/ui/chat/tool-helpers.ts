/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and wraps it in a code block with formatting.
 */
export function formatToolOutputForSidebar(text: string): string {
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

/**
 * Escapes HTML characters in a string.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Converts URLs in the text to clickable HTML links.
 * Automatically escapes the input text before adding links to prevent XSS.
 */
export function linkifyUrls(text: string): string {
  const escaped = escapeHtml(text);
  const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
  return escaped.replace(urlRegex, (url) => {
    let trailing = "";
    // Trim common trailing punctuation chars that might be part of the sentence
    while (url.length > 0 && /[.,)\]?!:;]$/.test(url)) {
      trailing = url.charAt(url.length - 1) + trailing;
      url = url.slice(0, -1);
    }
    if (url.length === 0) {
      return trailing;
    }
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>${trailing}`;
  });
}
