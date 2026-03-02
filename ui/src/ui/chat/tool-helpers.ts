/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

/**
 * Try to produce a human-friendly summary for well-known tool JSON outputs.
 * Returns undefined when no friendly summary is available.
 */
function friendlyJsonSummary(parsed: Record<string, unknown>): string | undefined {
  const status = parsed.status as string | undefined;

  // sessions_spawn result
  if (parsed.childSessionKey && parsed.runId) {
    const mode = (parsed.mode as string) ?? "run";
    const label = status === "accepted" ? "Spawned" : status ?? "done";
    return `**${label}** (${mode})`;
  }

  // subagents list
  if (parsed.action === "list" && Array.isArray(parsed.active)) {
    const active = (parsed.active as unknown[]).length;
    const recent = Array.isArray(parsed.recent) ? (parsed.recent as unknown[]).length : 0;
    return `**${active} active**, ${recent} recent`;
  }

  // session_status
  if (typeof parsed.model === "string" && typeof parsed.context === "string") {
    return parsed.context as string;
  }

  return undefined;
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
      // Try friendly summary first
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const friendly = friendlyJsonSummary(parsed as Record<string, unknown>);
        if (friendly) {
          return friendly + "\n\n<details><summary>Raw JSON</summary>\n\n```json\n" +
            JSON.stringify(parsed, null, 2) + "\n```\n</details>";
        }
      }
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
 * For well-known JSON outputs, returns a human-friendly one-liner instead.
 */
export function getTruncatedPreview(text: string): string {
  const trimmed = text.trim();

  // Try friendly preview for JSON tool outputs
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const friendly = friendlyJsonSummary(parsed);
      if (friendly) {
        // Strip markdown for inline preview
        return friendly.replace(/\*\*/g, "");
      }
    } catch {
      // fall through
    }
  }

  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
