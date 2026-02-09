import type { MarkdownTableMode } from "../config/types.base.js";
import { markdownToIRWithMeta } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";

const MARKDOWN_STYLE_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~~", close: "~~" },
  code: { open: "`", close: "`" },
  code_block: { open: "```\n", close: "```" },
} as const;

export type ConvertMarkdownTablesOptions = {
  headingStyle?: "none" | "bold" | "hash";
  blockquotePrefix?: string;
};

export function convertMarkdownTables(
  markdown: string,
  mode: MarkdownTableMode,
  options?: ConvertMarkdownTablesOptions,
): string {
  if (!markdown || mode === "off") {
    return markdown;
  }
  const { ir, hasTables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    headingStyle: options?.headingStyle ?? "none",
    blockquotePrefix: options?.blockquotePrefix ?? "",
    tableMode: mode,
  });
  if (!hasTables) {
    return markdown;
  }
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: MARKDOWN_STYLE_MARKERS,
    escapeText: (text) => text,
    buildLink: (link, text) => {
      const href = link.href.trim();
      if (!href) {
        return null;
      }
      const label = text.slice(link.start, link.end);
      if (!label) {
        return null;
      }
      return { start: link.start, end: link.end, open: "[", close: `](${href})` };
    },
  });
}
