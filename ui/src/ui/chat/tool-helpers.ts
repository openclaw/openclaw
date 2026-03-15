/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

function fenceFor(text: string): string {
  // Find longest run of consecutive backticks
  const match = text.match(/`+/g);
  if (!match) {
    return "```";
  }
  const maxLen = Math.max(...match.map((s) => s.length));
  // Use one more backtick than the longest run, minimum 3
  const fenceLen = Math.max(3, maxLen + 1);
  return "`".repeat(fenceLen);
}

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

export type SidebarArgsSection = {
  label: "Command" | "Args";
  body: string;
};

function jsonFence(value: unknown): string {
  const body = JSON.stringify(value, null, 2);
  const fence = fenceFor(body);
  return `${fence}json\n${body}\n${fence}`;
}

/**
 * Format full tool args for display in the sidebar.
 * When a command exists, preserve it as a dedicated full command section and
 * also keep any sibling args (cwd/env/etc) in a separate Args section.
 */
export function formatToolArgsForSidebar(args: unknown): SidebarArgsSection[] {
  if (args === null || args === undefined) {
    return [];
  }

  if (typeof args === "object") {
    const record = args as Record<string, unknown>;
    const sections: SidebarArgsSection[] = [];
    if (typeof record.command === "string") {
      const cmd = record.command;
      const fence = fenceFor(cmd);
      sections.push({
        label: "Command",
        body: `${fence}shell\n${cmd}\n${fence}`,
      });
      const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "command"));
      if (Object.keys(rest).length > 0) {
        sections.push({
          label: "Args",
          body: jsonFence(rest),
        });
      }
      return sections;
    }

    return [
      {
        label: "Args",
        body: jsonFence(args),
      },
    ];
  }

  if (typeof args === "string") {
    const fence = fenceFor(args);
    return [
      {
        label: "Args",
        body: `${fence}\n${args}\n${fence}`,
      },
    ];
  }

  return [
    {
      label: "Args",
      body: jsonFence(args),
    },
  ];
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
