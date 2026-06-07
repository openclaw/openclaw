// Hyperlink markdown helpers render markdown links with TUI hyperlink styling.
import type { Component, DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";

// Matches snake_case identifiers (is_palindrome) and dunder identifiers (__init__).
// Lookbehind/ahead prevent matching inside words or already-escaped underscores.
const UNDERSCORE_ID_RE =
  /(?<![\\\w])(?:[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]|__[A-Za-z][A-Za-z0-9_]*__)(?![\w])/g;

// Regions where underscores must not be touched: inline code, raw HTML blocks, HTML tags, links, URLs.
const INLINE_PROTECTED_RE =
  /(`+)(?:(?!\1)[\s\S])*?\1|<[A-Za-z][A-Za-z0-9]*(?:\s+[^<>\n]*)?>[\s\S]*?<\/[A-Za-z][A-Za-z0-9]*>|<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+[^<>\n]*)?>|\[[^\]\n]+\]\([^)]+\)|https?:\/\/[^\s<)]+/gi;

const FENCED_CODE_OPEN_RE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/g;

type Segment = { text: string; protected: boolean };

function partitionFencedCode(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(FENCED_CODE_OPEN_RE)) {
    const matchStart = match.index ?? 0;
    const start = matchStart + (match[1] ? 1 : 0);
    const openerEnd = matchStart + match[0].length;
    if (start < lastIndex) {
      continue;
    }
    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start), protected: false });
    }
    const marker = match[3] ?? "";
    const end = findFencedCodeEnd(text, openerEnd, marker);
    segments.push({ text: text.slice(start, end), protected: true });
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), protected: false });
  }
  return segments;
}

function findFencedCodeEnd(text: string, from: number, marker: string): number {
  const fenceChar = marker[0];
  const fenceLength = marker.length;
  let lineStart = from;
  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    const closeMatch = /^( {0,3})(`+|~+)[ \t]*$/u.exec(line);
    const closeMarker = closeMatch?.[2] ?? "";
    if (closeMarker[0] === fenceChar && closeMarker.length >= fenceLength) {
      return end;
    }
    lineStart = end;
  }
  return text.length;
}

function escapeUnderscores(identifier: string): string {
  return identifier.replaceAll("_", "\\_");
}

function escapeIdentifiersOutsideInlineProtected(text: string): string {
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PROTECTED_RE)) {
    const start = match.index ?? 0;
    result += text.slice(lastIndex, start).replace(UNDERSCORE_ID_RE, escapeUnderscores);
    result += match[0];
    lastIndex = start + match[0].length;
  }
  result += text.slice(lastIndex).replace(UNDERSCORE_ID_RE, escapeUnderscores);
  return result;
}

function escapeUnderscoreIdentifiers(text: string): string {
  return partitionFencedCode(text)
    .map((seg) => (seg.protected ? seg.text : escapeIdentifiersOutsideInlineProtected(seg.text)))
    .join("");
}

/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export class HyperlinkMarkdown implements Component {
  private inner: Markdown;
  private urls: string[];

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    options?: DefaultTextStyle,
  ) {
    this.inner = new Markdown(
      escapeUnderscoreIdentifiers(text),
      paddingX,
      paddingY,
      theme,
      options,
    );
    this.urls = extractUrls(text);
  }

  render(width: number): string[] {
    return addOsc8Hyperlinks(this.inner.render(width), this.urls);
  }

  setText(text: string): void {
    this.inner.setText(escapeUnderscoreIdentifiers(text));
    this.urls = extractUrls(text);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
