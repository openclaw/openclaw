// Hyperlink markdown helpers render markdown links with TUI hyperlink styling.
import type { Component, DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";

type MarkdownToken = { type: string; lang?: string; text?: string };
type RenderToken = (
  token: MarkdownToken,
  width: number,
  nextTokenType?: string,
  styleContext?: unknown,
) => string[];

const CODE_WRAP_TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;
const WHITESPACE_RE = /^\s+$/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function splitTokenToWidth(token: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const { segment } of graphemeSegmenter.segment(token)) {
    if (current && visibleWidth(`${current}${segment}`) > maxWidth) {
      chunks.push(current);
      current = "";
    }
    current += segment;
  }
  if (current || chunks.length === 0) {
    chunks.push(current);
  }
  return chunks;
}

function wrapCodeLine(line: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const tokens = line.match(CODE_WRAP_TOKEN_RE) ?? [line];
  const rows: string[] = [];
  let current = "";

  const pushCurrent = () => {
    rows.push(current.trimEnd());
    current = "";
  };

  for (const token of tokens) {
    const isWhitespace = WHITESPACE_RE.test(token);
    if (current === "" && rows.length > 0 && isWhitespace) {
      continue;
    }
    if (visibleWidth(`${current}${token}`) <= width) {
      current += token;
      continue;
    }
    if (current) {
      pushCurrent();
    }
    if (isWhitespace) {
      current = token.length <= width ? token : token.slice(0, width);
      continue;
    }
    if (visibleWidth(token) <= width) {
      current = token;
      continue;
    }
    const chunks = splitTokenToWidth(token, width);
    rows.push(...chunks.slice(0, -1));
    current = chunks.at(-1) ?? "";
  }

  if (current || rows.length === 0) {
    pushCurrent();
  }
  return rows;
}

function fitCodeLineWithIndent(line: string, indent: string, maxWidth: number): string {
  const width = Math.max(1, maxWidth);
  const lineWidth = visibleWidth(line);
  const indentWidth = Math.max(0, width - Math.min(lineWidth, width));
  const effectiveIndent = visibleWidth(indent) <= indentWidth ? indent : " ".repeat(indentWidth);
  const combined = `${effectiveIndent}${line}`;
  return visibleWidth(combined) <= width ? combined : truncateToWidth(combined, width);
}

function renderCodeToken(
  token: MarkdownToken,
  width: number,
  nextTokenType: string | undefined,
  theme: MarkdownTheme,
): string[] {
  const contentWidth = Math.max(1, width);
  const language = token.lang || undefined;
  const indent = theme.codeBlockIndent ?? "  ";
  const codeWidth = Math.max(1, contentWidth - visibleWidth(indent));
  const wrappedCodeLines = (token.text ?? "")
    .split("\n")
    .flatMap((line) => wrapCodeLine(line, codeWidth));
  const highlightedLines = theme.highlightCode
    ? wrappedCodeLines.flatMap((line) => theme.highlightCode?.(line, language) ?? [])
    : wrappedCodeLines.map((line) => theme.codeBlock(line));
  const lines = wrapCodeLine(`\`\`\`${language ?? ""}`, contentWidth).map((line) =>
    theme.codeBlockBorder(line),
  );
  for (const line of highlightedLines) {
    lines.push(fitCodeLineWithIndent(line, indent, contentWidth));
  }
  lines.push(...wrapCodeLine("```", contentWidth).map((line) => theme.codeBlockBorder(line)));
  if (nextTokenType && nextTokenType !== "space") {
    lines.push("");
  }
  return lines;
}

function createCodeAwareMarkdown(
  text: string,
  paddingX: number,
  paddingY: number,
  theme: MarkdownTheme,
  defaultTextStyle?: DefaultTextStyle,
): Markdown {
  const markdown = new Markdown(text, paddingX, paddingY, theme, defaultTextStyle);
  const patched = markdown as unknown as { renderToken: RenderToken };
  const renderToken: RenderToken = patched.renderToken.bind(markdown);
  patched.renderToken = (
    token: MarkdownToken,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown,
  ) => {
    if (token.type === "code") {
      return renderCodeToken(token, width, nextTokenType, theme);
    }
    return renderToken(token, width, nextTokenType, styleContext);
  };
  return markdown;
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
    defaultTextStyle?: DefaultTextStyle,
  ) {
    this.inner = createCodeAwareMarkdown(text, paddingX, paddingY, theme, defaultTextStyle);
    this.urls = extractUrls(text);
  }

  render(width: number): string[] {
    return addOsc8Hyperlinks(this.inner.render(width), this.urls);
  }

  setText(text: string): void {
    this.inner.setText(text);
    this.urls = extractUrls(text);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
