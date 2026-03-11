/**
 * Helper functions for tool card rendering.
 */

import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
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

function resolveExecCommandForSidebar(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}

export function formatToolSidebarContent(card: {
  name: string;
  args?: unknown;
  text?: string;
}): string {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const fullExecCommand =
    card.name === "exec" ? resolveExecCommandForSidebar(card.args) : undefined;
  const sections: string[] = [`## ${display.label}`];

  if (fullExecCommand) {
    sections.push("", "**Command:**", "```sh", fullExecCommand, "```");
  } else if (detail) {
    sections.push("", `**Details:** ${detail}`);
  }

  if (card.text?.trim()) {
    sections.push("", formatToolOutputForSidebar(card.text));
  } else {
    sections.push("", "*No output — tool completed successfully.*");
  }

  return sections.join("\n");
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
