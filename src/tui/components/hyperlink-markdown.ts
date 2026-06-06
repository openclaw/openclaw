// Hyperlink markdown helpers render markdown links with TUI hyperlink styling.
import type { Component, DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import { addOsc8Hyperlinks, extractUrls } from "../osc8-hyperlinks.js";

const FENCED_CODE_OPEN_RE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/g;
const INLINE_PROTECTED_MARKDOWN_RE =
  /(`+)(?:(?!\1)[\s\S])*?\1|<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+[^<>\n]*)?>|\[[^\]\n]+\]\([^)]+\)|https?:\/\/[^\s<)]+/g;
const RAW_HTML_SPAN_RE =
  /<(a|article|aside|blockquote|body|code|div|em|footer|h[1-6]|head|header|html|li|main|nav|ol|p|pre|script|section|span|strong|style|table|tbody|td|tfoot|th|thead|tr|ul)(?:\s+[^<>\n]*)?>[\s\S]*?<\/\1>/gi;
const SNAKE_CASE_IDENTIFIER_RE =
  /(?<![\\\w])[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9](?![\w])/g;
const DUNDER_IDENTIFIER_RE = /(?<![\\\w])__[A-Za-z][A-Za-z0-9_]*__(?![\w])/g;
const DUNDER_CODE_CONTEXT_BEFORE_RE =
  /\b(?:call(?:ing)?|class|dunder|implement(?:ed|ing|s)?|identifier|method|python|use|using)\b[\s\S]{0,96}$/i;
const DUNDER_CODE_CONTEXT_MARK_RE = /^[\s]*[=()[\]{}:+\-*/<>'"`]/;
const DUNDER_CODE_CONTEXT_PREV_RE = /[=()[\]{}:+\-*/<>'"`]\s*$/;
const PYTHON_DUNDER_VALUE_NAMES = new Set(
  [
    "abs add aenter aexit all annotations aiter and annotate anext await bases bool buffer",
    "builtins bytes call cached ceil class class_getitem complex contains debug del delattr",
    "delete delitem dict dir divmod doc enter eq exit file firstlineno float floor floordiv",
    "format fspath ge get getattr getattribute getitem getnewargs getnewargs_ex getstate",
    "gt hash iadd iand ifloordiv ilshift imatmul imod imul index init init_subclass",
    "instancecheck int invert ior ipow irshift isabstractmethod isub iter itruediv ixor",
    "le len length_hint loader lshift lt main match_args matmul missing mod module mro",
    "mro_entries mul name ne neg new next or orig_bases package parameters path pos pow",
    "prepare qualname radd rand rdivmod reduce reduce_ex repr reversed rfloordiv rlshift",
    "rmatmul rmod rmul ror round rpow rrshift rshift rsub rtruediv rxor set set_name",
    "setattr setitem setstate sizeof slots spec static_attributes str sub subclasscheck",
    "subclasshook subclasses text_signature truediv trunc type_params version weakref xor",
  ]
    .join(" ")
    .split(" "),
);

type MarkdownSegment = {
  text: string;
  protected: boolean;
};

function partitionProtectedMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
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

function escapeUnderscoreIdentifier(identifier: string): string {
  return identifier.replaceAll("_", "\\_");
}

function protectDunderIdentifier(identifier: string, index: number, source: string): string {
  const name = identifier.slice(2, -2);
  const before = source.slice(Math.max(0, index - 96), index);
  const after = source.slice(index + identifier.length, index + identifier.length + 16);
  const hasCodeContext =
    DUNDER_CODE_CONTEXT_BEFORE_RE.test(before) ||
    DUNDER_CODE_CONTEXT_PREV_RE.test(before) ||
    DUNDER_CODE_CONTEXT_MARK_RE.test(after);
  if (PYTHON_DUNDER_VALUE_NAMES.has(name) && hasCodeContext) {
    return escapeUnderscoreIdentifier(identifier);
  }
  return identifier;
}

function protectInlineMarkdown(segment: string): string {
  return segment
    .replace(DUNDER_IDENTIFIER_RE, protectDunderIdentifier)
    .replace(SNAKE_CASE_IDENTIFIER_RE, escapeUnderscoreIdentifier);
}

function protectUnderscoredIdentifiersOutsideInlineMarkdown(text: string): string {
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PROTECTED_MARKDOWN_RE)) {
    const start = match.index ?? 0;
    result += protectInlineMarkdown(text.slice(lastIndex, start));
    result += match[0];
    lastIndex = start + match[0].length;
  }
  result += protectInlineMarkdown(text.slice(lastIndex));
  return result;
}

function protectUnderscoredIdentifiersOutsideRawHtml(text: string): string {
  let result = "";
  let lastIndex = 0;
  for (const match of text.matchAll(RAW_HTML_SPAN_RE)) {
    const start = match.index ?? 0;
    result += protectUnderscoredIdentifiersOutsideInlineMarkdown(text.slice(lastIndex, start));
    result += match[0];
    lastIndex = start + match[0].length;
  }
  result += protectUnderscoredIdentifiersOutsideInlineMarkdown(text.slice(lastIndex));
  return result;
}

function protectUnderscoredIdentifiers(text: string): string {
  return partitionProtectedMarkdown(text)
    .map((segment) =>
      segment.protected ? segment.text : protectUnderscoredIdentifiersOutsideRawHtml(segment.text),
    )
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
      protectUnderscoredIdentifiers(text),
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
    this.inner.setText(protectUnderscoredIdentifiers(text));
    this.urls = extractUrls(text);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
