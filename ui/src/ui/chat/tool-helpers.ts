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
 * Format tool-call input/arguments for display in the sidebar.
 * Uses JSON code blocks for structured values and preserves plain text input.
 */
export function formatToolPayloadForSidebar(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return formatToolOutputForSidebar(value);
  }
  try {
    return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
  } catch {
    return String(value);
  }
}

export function buildToolSidebarContent(params: {
  title: string;
  detail?: string;
  args?: unknown;
  output?: string;
}): string {
  const sections = [`## ${params.title}`];
  if (params.detail) {
    sections.push(`**Command:** \`${params.detail}\``);
  }
  const args = formatToolPayloadForSidebar(params.args);
  if (args !== null) {
    sections.push(`**Arguments**\n${args}`);
  }
  if (typeof params.output === "string") {
    sections.push(`**Output**\n${formatToolOutputForSidebar(params.output)}`);
  } else {
    sections.push("*No output - tool completed successfully.*");
  }
  return sections.join("\n\n");
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
