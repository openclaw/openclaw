/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

type ToolOutputFormatOptions = {
  toolName?: string;
  args?: unknown;
};

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and wraps it in a code block with formatting.
 */
export function formatToolOutputForSidebar(
  text: string,
  options: ToolOutputFormatOptions = {},
): string {
  const normalizedToolName = normalizeToolName(options.toolName);
  if (normalizedToolName === "edit") {
    const diffMarkdown = formatEditArgsAsDiff(options.args);
    if (diffMarkdown) {
      return diffMarkdown;
    }
  }

  const trimmed = text.trim();
  if (normalizedToolName === "read") {
    const readMarkdown = formatReadJsonPayload(trimmed, options.args);
    if (readMarkdown) {
      return readMarkdown;
    }
  }

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

function normalizeToolName(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function resolvePath(value: unknown): string | null {
  const record = asRecord(value);
  return pickString(record, ["path", "file_path", "filePath"]);
}

function formatReadJsonPayload(trimmedText: string, args: unknown): string | null {
  if (!trimmedText || (!trimmedText.startsWith("{") && !trimmedText.startsWith("["))) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmedText) as unknown;
    const parsedRecord = asRecord(parsed);
    const content = pickString(parsedRecord, ["content", "text"]);
    if (!content) {
      return null;
    }
    const path = resolvePath(parsedRecord) ?? resolvePath(args);
    const header = path ? `### ${path}\n\n` : "";
    return `${header}\`\`\`\n${content}\n\`\`\``;
  } catch {
    return null;
  }
}

function formatEditArgsAsDiff(args: unknown): string | null {
  const record = asRecord(args);
  const oldText = pickString(record, ["old_string", "oldText"]);
  const newText = pickString(record, ["new_string", "newText", "content"]);
  if (oldText == null || newText == null) {
    return null;
  }
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  const diffBody = createLineDiff(oldLines, newLines);
  const path = resolvePath(record);
  const header = path ? `### ${path}\n\n` : "";
  return `${header}\`\`\`diff\n${diffBody}\n\`\`\``;
}

function createLineDiff(oldLines: string[], newLines: string[]): string {
  const maxGrid = 50_000;
  if (oldLines.length * newLines.length > maxGrid) {
    const removed = oldLines.map((line) => `-${line}`);
    const added = newLines.map((line) => `+${line}`);
    return [...removed, ...added].join("\n");
  }

  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const lcs = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push(` ${oldLines[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${oldLines[i]}`);
      i += 1;
      continue;
    }
    out.push(`+${newLines[j]}`);
    j += 1;
  }

  while (i < oldLines.length) {
    out.push(`-${oldLines[i]}`);
    i += 1;
  }
  while (j < newLines.length) {
    out.push(`+${newLines[j]}`);
    j += 1;
  }
  return out.join("\n");
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
