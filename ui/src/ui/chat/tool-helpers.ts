/**
 * Helper functions for tool card rendering.
 */

import { normalizeTerminalText } from "../format.ts";
import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

function wrapInCodeFence(text: string, lang?: string): string {
  const matches = text.match(/`+/g) ?? [];
  const longest = matches.reduce((max, m) => Math.max(max, m.length), 0);
  const fenceLen = Math.max(3, longest + 1);
  const fence = "`".repeat(fenceLen);
  const info = lang ? lang : "";
  return `${fence}${info}\n${text}\n${fence}`;
}

function looksLikeUnifiedDiff(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith("--- ")) {
    return false;
  }
  return t.includes("\n+++ ") && (t.includes("\n@@") || t.includes("\n+ ") || t.includes("\n- "));
}

/**
 * Format tool output content for display in the sidebar.
 *
 * The sidebar renderer is markdown-based, so we wrap tool output in a code fence to:
 * - preserve whitespace/newlines
 * - avoid markdown eating characters (e.g. glob paths like `src/**.test.ts`)
 * - keep output readable across operating systems and tools
 */
export function formatToolOutputForSidebar(text: string): string {
  if (text === "") {
    return "";
  }
  if (text.trim() === "") {
    // Preserve whitespace-only output as-is.
    return text;
  }

  const normalized = normalizeTerminalText(text);
  const trimmed = normalized.trim();

  if (looksLikeUnifiedDiff(trimmed)) {
    return wrapInCodeFence(normalized, "diff");
  }

  // Try to detect and pretty-print JSON.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return wrapInCodeFence(JSON.stringify(parsed, null, 2), "json");
    } catch {
      // Not valid JSON, fall through.
    }
  }

  return wrapInCodeFence(normalized, "text");
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const normalized = normalizeTerminalText(text);
  const allLines = normalized.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
