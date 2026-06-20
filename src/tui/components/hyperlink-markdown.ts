// Hyperlink markdown helpers render markdown links with TUI hyperlink styling.
import type { Component, DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";

type MarkdownSegment =
  | { kind: "markdown"; text: string }
  | { kind: "code"; prefix: string; fence: string; info: string; lines: string[]; closed: boolean };

const OPEN_FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CODE_WRAP_TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;
const WHITESPACE_RE = /^\s+$/;

function parseOpeningFence(
  line: string,
): { prefix: string; fence: string; info: string } | undefined {
  const match = OPEN_FENCE_RE.exec(line);
  if (!match) {
    return undefined;
  }
  const fence = match[2];
  const info = match[3].trim();
  if (fence[0] === "`" && info.includes("`")) {
    return undefined;
  }
  return { prefix: match[1], fence, info };
}

function parseInvalidBacktickFence(line: string): { fence: string } | undefined {
  const match = OPEN_FENCE_RE.exec(line);
  if (!match || match[2][0] !== "`" || !match[3].includes("`")) {
    return undefined;
  }
  return { fence: match[2] };
}

function isClosingFence(line: string, openingFence: string): boolean {
  const marker = openingFence[0];
  const minLength = openingFence.length;
  const withoutIndent = line.replace(/^ {0,3}/, "").trimEnd();
  let markerLength = 0;
  while (withoutIndent[markerLength] === marker) {
    markerLength += 1;
  }
  return markerLength >= minLength && withoutIndent.slice(markerLength).trim() === "";
}

function parseMarkdownSegments(text: string): MarkdownSegment[] {
  const lines = text.replace(/\t/g, "   ").split("\n");
  const segments: MarkdownSegment[] = [];
  let markdownLines: string[] = [];

  const flushMarkdown = () => {
    if (markdownLines.length > 0) {
      segments.push({ kind: "markdown", text: markdownLines.join("\n") });
      markdownLines = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const opening = parseOpeningFence(lines[i]);
    if (!opening) {
      const invalidOpening = parseInvalidBacktickFence(lines[i]);
      markdownLines.push(lines[i]);
      if (invalidOpening) {
        i += 1;
        for (; i < lines.length; i += 1) {
          markdownLines.push(lines[i]);
          if (isClosingFence(lines[i], invalidOpening.fence)) {
            break;
          }
        }
      }
      continue;
    }

    flushMarkdown();
    const codeLines: string[] = [];
    let closed = false;
    i += 1;
    for (; i < lines.length; i += 1) {
      if (isClosingFence(lines[i], opening.fence)) {
        closed = true;
        break;
      }
      codeLines.push(lines[i]);
    }
    segments.push({ kind: "code", ...opening, lines: codeLines, closed });
  }

  flushMarkdown();
  return segments;
}

function hasFencedCode(text: string): boolean {
  return parseMarkdownSegments(text).some((segment) => segment.kind === "code");
}

function splitTokenToWidth(token: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of Array.from(token)) {
    if (current && visibleWidth(`${current}${char}`) > maxWidth) {
      chunks.push(current);
      current = "";
    }
    current += char;
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

/**
 * Wrapper around pi-tui's Markdown component that adds OSC 8 terminal
 * hyperlinks to rendered output, making URLs clickable even when broken
 * across multiple lines by word wrapping.
 */
export class HyperlinkMarkdown implements Component {
  private inner: Markdown;
  private urls: string[];
  private text: string;

  constructor(
    text: string,
    private paddingX: number,
    private paddingY: number,
    private theme: MarkdownTheme,
    private defaultTextStyle?: DefaultTextStyle,
  ) {
    this.text = text;
    this.inner = new Markdown(text, paddingX, paddingY, theme, defaultTextStyle);
    this.urls = extractUrls(text);
  }

  render(width: number): string[] {
    const rendered = hasFencedCode(this.text)
      ? this.renderWithVerbatimFencedCode(width)
      : this.inner.render(width);
    return addOsc8Hyperlinks(rendered, this.urls);
  }

  setText(text: string): void {
    this.text = text;
    this.inner.setText(text);
    this.urls = extractUrls(text);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  private renderWithVerbatimFencedCode(width: number): string[] {
    if (!this.text || this.text.trim() === "") {
      return [];
    }

    const renderedLines: string[] = [];
    for (const segment of parseMarkdownSegments(this.text)) {
      if (segment.kind === "markdown") {
        renderedLines.push(...this.renderMarkdownSegment(segment.text, width));
      } else {
        renderedLines.push(...this.renderCodeSegment(segment, width));
      }
    }

    if (renderedLines.length === 0) {
      return [""];
    }

    const emptyLines = Array.from({ length: this.paddingY }, () => this.applyLineChrome("", width));
    return emptyLines.concat(renderedLines, emptyLines);
  }

  private renderMarkdownSegment(text: string, width: number): string[] {
    if (!text || text.trim() === "") {
      return [];
    }
    return new Markdown(text, this.paddingX, 0, this.theme, this.defaultTextStyle).render(width);
  }

  private renderCodeSegment(
    segment: Extract<MarkdownSegment, { kind: "code" }>,
    width: number,
  ): string[] {
    const language = segment.info.split(/\s+/, 1)[0] || undefined;
    const indent = this.theme.codeBlockIndent ?? "  ";
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const codeWidth = Math.max(1, contentWidth - visibleWidth(indent));
    const wrappedCodeLines = segment.lines.flatMap((line) => wrapCodeLine(line, codeWidth));
    const highlightCode = this.theme.highlightCode;
    const highlightedLines = highlightCode
      ? wrappedCodeLines.flatMap((line) => highlightCode(line, language))
      : wrappedCodeLines.map((line) => this.theme.codeBlock(line));
    const borderPrefixWidth = visibleWidth(segment.prefix);
    const borderWidth = Math.max(1, contentWidth - borderPrefixWidth);
    const renderBorderLine = (line: string) =>
      this.theme.codeBlockBorder(`${segment.prefix}${line}`);
    const lines = wrapCodeLine(`${segment.fence}${segment.info}`, borderWidth).map(
      renderBorderLine,
    );
    for (const line of highlightedLines) {
      lines.push(fitCodeLineWithIndent(line, indent, contentWidth));
    }
    if (segment.closed) {
      lines.push(...wrapCodeLine(segment.fence, borderWidth).map(renderBorderLine));
    }
    return lines.map((line) => this.applyLineChrome(line, width));
  }

  private applyLineChrome(line: string, width: number): string {
    const margin = " ".repeat(this.paddingX);
    const withMargins = `${margin}${line}${margin}`;
    const paddingNeeded = Math.max(0, width - visibleWidth(withMargins));
    const padded = `${withMargins}${" ".repeat(paddingNeeded)}`;
    return this.defaultTextStyle?.bgColor ? this.defaultTextStyle.bgColor(padded) : padded;
  }
}
