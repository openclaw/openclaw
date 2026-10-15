import type { MarkdownIt, Token } from "markdown-it";
import { stripUnsupportedCitationControlMarkers } from "../../../src/shared/text/citation-control-markers.js";
import { parseMarkdownJson } from "./markdown-json.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import { MARKDOWN_PARSE_LIMIT, normalizeMarkdownRenderOptions } from "./markdown-render-options.ts";
import { normalizeMarkdownLineBreaks } from "./markdown-text.ts";

// Transcript search compares what a reader sees, not the syntax around it:
// `Title: \`fix\`` must match "title: fix". Parse with the transcript's own
// rules so raw HTML stays literal and disclosure summaries keep their inline text.
let parser: MarkdownIt | undefined;
// Every transcript bubble shortens file-link labels while parsing; per-message
// options (mention names, repository context) stay with the source fallback.
const PROJECTION_OPTIONS = { fileLinks: true, sessionLinks: true } as const;
const visibleTexts = new WeakMap<object, { markdown: string; text: string }>();

function collectVisibleText(tokens: readonly Token[], parts: string[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "inline":
        collectVisibleText(token.children ?? [], parts);
        break;
      case "text":
      case "code_inline":
      case "code_block":
      case "fence":
        parts.push(token.content);
        break;
      case "html_block":
      case "html_inline":
        // Raw HTML renders escaped; generated task-list checkboxes have no text.
        if (token.meta?.taskListPlugin !== true) {
          parts.push(/^<br\s*\/?>$/iu.test(token.content.trim()) ? "\n" : token.content);
        }
        break;
      case "softbreak":
      case "hardbreak":
        parts.push("\n");
        break;
      case "image":
        // Images render as media or a notice; a phrase must not match across them.
        parts.push("￼");
        break;
      default:
        if (token.block && token.nesting === -1) {
          parts.push("\n");
        }
    }
  }
}

/** Plain text of rendered Markdown, cached on the immutable owner of `markdown`. */
export function markdownVisibleText(owner: unknown, markdown: string): string {
  const cacheOwner = owner !== null && typeof owner === "object" ? owner : undefined;
  const cached = cacheOwner && visibleTexts.get(cacheOwner);
  if (cached && cached.markdown === markdown) {
    return cached.text;
  }
  // Messages above the parse budget and JSON messages render as literal source text.
  if (markdown.length > MARKDOWN_PARSE_LIMIT || parseMarkdownJson(markdown)) {
    return markdown;
  }
  const parts: string[] = [];
  try {
    parser ??= createMarkdownParser();
    const source = normalizeMarkdownLineBreaks(stripUnsupportedCitationControlMarkers(markdown));
    collectVisibleText(
      parser.parse(source, normalizeMarkdownRenderOptions(PROJECTION_OPTIONS)),
      parts,
    );
  } catch {
    // The renderer falls back to escaped source text when parsing fails.
    return markdown;
  }
  const text = parts.join("");
  if (cacheOwner) {
    visibleTexts.set(cacheOwner, { markdown, text });
  }
  return text;
}
