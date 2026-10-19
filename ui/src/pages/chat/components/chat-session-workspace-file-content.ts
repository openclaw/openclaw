import { formatInlineCodeSpan } from "../../../../../src/shared/markdown-code.js";
import type { SessionFileDownload } from "../../../api/session-file-download.ts";
import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
import { pathDisplayName } from "../../../lib/path-display.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

function formatMarkdownCodeSpan(value: string): string {
  // Markdown finds block boundaries before inline spans, so filenames must
  // stay on one logical line even when the Gateway returns hostile metadata.
  const singleLineValue = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const hasBoundarySpaces = singleLineValue.startsWith(" ") && singleLineValue.endsWith(" ");
  return formatInlineCodeSpan(
    hasBoundarySpaces && !/^ +$/.test(singleLineValue) ? ` ${singleLineValue} ` : singleLineValue,
  );
}

function formatFileUpdatedAt(updatedAtMs: number | undefined): string | null {
  if (typeof updatedAtMs !== "number") {
    return null;
  }
  const updatedAt = new Date(updatedAtMs);
  return Number.isNaN(updatedAt.getTime()) ? null : updatedAt.toISOString();
}

export function unsupportedFileSidebarContent(
  file: SessionWorkspaceGetResult["file"],
  fallbackPath: string,
  download: (signal: AbortSignal) => Promise<SessionFileDownload | null>,
): SidebarContent {
  const filePath = file.workspacePath || file.path || fallbackPath;
  const updatedAt = formatFileUpdatedAt(file.updatedAtMs);
  const lines = [
    "This file is not previewable inline.",
    "",
    `- Path: ${formatMarkdownCodeSpan(filePath)}`,
    file.mimeType ? `- Type: ${formatMarkdownCodeSpan(file.mimeType)}` : null,
    typeof file.size === "number" ? `- Size: ${file.size.toLocaleString()} bytes` : null,
    updatedAt ? `- Updated: ${updatedAt}` : null,
  ].filter((line): line is string => line !== null);
  const content = lines.join("\n");
  return {
    kind: "markdown",
    content,
    rawText: content,
    fileDownload: {
      path: filePath,
      name: file.name || pathDisplayName(filePath),
      download,
    },
  };
}

export function hasUniformLineEndings(content: string): boolean {
  return new Set(content.match(/\r\n?|\n/g)).size <= 1;
}
