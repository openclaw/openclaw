import type { MarkdownIt, StateBlock } from "markdown-it";
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/reasoning-tags.js";

const MAX_MARKDOWN_DETAILS_DEPTH = 32;
const DISCLOSURE_TAG_RE = /<\/?(?:details|summary)(?=[\s>])[^>]*>/gi;
const DETAILS_OPEN_RE = /^<details( open)?>$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;
const SUMMARY_OPEN_RE = /^<summary>$/i;
const SUMMARY_CLOSE_RE = /^<\/summary>$/i;
const DETAILS_STACK = Symbol("markdownDetailsStack");

export type MarkdownDetailsFrame = { hasSummary: boolean };
type DetailsBlockState = StateBlock & { [DETAILS_STACK]?: MarkdownDetailsFrame[] };
type DetailsToken = ReturnType<StateBlock["push"]>;
type DetailsTokenSink = {
  push(type: string, tag: string, nesting: -1 | 0 | 1): DetailsToken;
};
type MarkdownRawHtmlContext =
  | "comment"
  | "processing_instruction"
  | "declaration"
  | "cdata"
  | { element: string };

type MarkdownRawHtmlState = { context: MarkdownRawHtmlContext | null };

type MarkdownDisclosureTag = {
  end: number;
  raw: string;
  start: number;
};

type MarkdownDisclosureTagKind =
  | "details_open"
  | "details_open_expanded"
  | "details_close"
  | "summary_open"
  | "summary_close";

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isInsideMarkdownCode(
  index: number,
  codeSpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  return codeSpans.some(([start, end]) => index >= start && index < end);
}

function markdownDisclosureTagKind(raw: string): MarkdownDisclosureTagKind | null {
  const detailsOpen = DETAILS_OPEN_RE.exec(raw);
  if (detailsOpen) {
    return detailsOpen[1] ? "details_open_expanded" : "details_open";
  }
  if (DETAILS_CLOSE_RE.test(raw)) {
    return "details_close";
  }
  if (SUMMARY_OPEN_RE.test(raw)) {
    return "summary_open";
  }
  return SUMMARY_CLOSE_RE.test(raw) ? "summary_close" : null;
}

/** Disclosure markup is structural only when it starts the current Markdown block line. */
export function scanMarkdownDisclosureLine(
  line: string,
  codeSpans: ReadonlyArray<readonly [number, number]> = findMarkdownCodeSpans(line),
  lineOffset = 0,
): MarkdownDisclosureTag[] | null {
  const first = /^[ \t]*<\/?(?:details|summary)(?=[\s>])/i.exec(line);
  if (!first) {
    return null;
  }
  const tags: MarkdownDisclosureTag[] = [];
  for (const match of line.matchAll(DISCLOSURE_TAG_RE)) {
    const start = match.index ?? 0;
    if (
      isEscapedMarkdownCharacter(line, start) ||
      isInsideMarkdownCode(lineOffset + start, codeSpans)
    ) {
      continue;
    }
    tags.push({ end: start + match[0].length, raw: match[0], start });
  }
  return tags.length > 0 ? tags : null;
}

function pushInlineParagraph(state: DetailsTokenSink, content: string, line: number): void {
  if (!content.trim()) {
    return;
  }
  const open = state.push("paragraph_open", "p", 1);
  open.map = [line, line + 1];
  const inline = state.push("inline", "", 0);
  inline.content = content;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push("paragraph_close", "p", -1);
}

function pushSummary(state: DetailsTokenSink, label: string, line: number): void {
  const open = state.push("summary_open", "summary", 1);
  open.map = [line, line + 1];
  const inline = state.push("inline", "", 0);
  inline.content = label;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push("summary_close", "summary", -1);
}

/** Share nesting decisions between rendered blocks and streaming-tail repair. */
export function walkMarkdownDisclosureTags(
  tags: readonly MarkdownDisclosureTag[],
  stack: MarkdownDetailsFrame[],
  options: {
    allowPendingSummary?: boolean;
    onOpen?: (tag: MarkdownDisclosureTag, expanded: boolean) => void;
    onClose?: (tag: MarkdownDisclosureTag) => void;
    onSummary?: (open: MarkdownDisclosureTag, close: MarkdownDisclosureTag) => void;
  } = {},
): boolean {
  const kinds = tags.map((tag) => markdownDisclosureTagKind(tag.raw));
  const nextSummaryClose = Array.from({ length: tags.length }, () => -1);
  let nearestSummaryClose = -1;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    nextSummaryClose[index] = nearestSummaryClose;
    if (kinds[index] === "summary_close") {
      nearestSummaryClose = index;
    }
  }
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!tag) {
      continue;
    }
    const kind = kinds[index];
    if (
      (kind === "details_open" || kind === "details_open_expanded") &&
      stack.length < MAX_MARKDOWN_DETAILS_DEPTH
    ) {
      options.onOpen?.(tag, kind === "details_open_expanded");
      stack.push({ hasSummary: false });
    } else if (kind === "details_close" && stack.length > 0) {
      options.onClose?.(tag);
      stack.pop();
    } else if (kind === "summary_open") {
      const frame = stack.at(-1);
      if (!frame || frame.hasSummary) {
        continue;
      }
      const closeIndex = nextSummaryClose[index] ?? -1;
      const close = closeIndex >= 0 ? tags[closeIndex] : undefined;
      if (close) {
        options.onSummary?.(tag, close);
        frame.hasSummary = true;
        index = closeIndex;
      } else if (options.allowPendingSummary) {
        return true;
      }
    }
  }
  return false;
}

function pushDisclosureLine(
  state: DetailsTokenSink,
  line: string,
  lineNumber: number,
  stack: MarkdownDetailsFrame[],
): boolean {
  const tags = scanMarkdownDisclosureLine(line);
  if (!tags) {
    return false;
  }
  let cursor = 0;
  const flushText = (tag: MarkdownDisclosureTag, end = tag.end) => {
    // Unaccepted tags stay in the literal span between structural events.
    pushInlineParagraph(state, line.slice(cursor, tag.start), lineNumber);
    cursor = end;
  };
  walkMarkdownDisclosureTags(tags, stack, {
    onOpen(tag, expanded) {
      flushText(tag);
      const token = state.push("details_open", "details", 1);
      if (expanded) {
        token.attrSet("open", "");
      }
    },
    onClose(tag) {
      flushText(tag);
      state.push("details_close", "details", -1);
    },
    onSummary(open, close) {
      flushText(open, close.end);
      pushSummary(state, line.slice(open.end, close.start), lineNumber);
    },
  });
  pushInlineParagraph(state, line.slice(cursor), lineNumber);
  return true;
}

function detailsBlockRule(
  state: DetailsBlockState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) {
    return false;
  }
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  const end = state.eMarks[startLine] ?? state.src.length;
  const line = state.src.slice(start, end);
  if (!scanMarkdownDisclosureLine(line)) {
    return false;
  }
  if (silent) {
    return true;
  }

  pushDisclosureLine(state, line, startLine, (state[DETAILS_STACK] ??= []));
  state.line = startLine + 1;
  return true;
}

function openingRawHtmlContext(line: string): MarkdownRawHtmlContext | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("<!--")) {
    return "comment";
  }
  if (trimmed.startsWith("<?")) {
    return "processing_instruction";
  }
  if (trimmed.startsWith("<![CDATA[")) {
    return "cdata";
  }
  if (/^<![A-Za-z]/.test(trimmed)) {
    return "declaration";
  }
  const element = /^<(pre|script|style|textarea)(?=[\s>]|$)/i.exec(trimmed)?.[1];
  return element ? { element: element.toLowerCase() } : null;
}

function closesRawHtmlContext(context: MarkdownRawHtmlContext, line: string): boolean {
  if (typeof context === "object") {
    return line.toLowerCase().includes(`</${context.element}>`);
  }
  if (context === "comment") {
    return line.includes("-->");
  }
  if (context === "processing_instruction") {
    return line.includes("?>");
  }
  if (context === "declaration") {
    return line.includes(">");
  }
  return line.includes("]]>");
}

export function consumeMarkdownRawHtmlLine(
  line: string,
  state: MarkdownRawHtmlState,
  codeSpans: ReadonlyArray<readonly [number, number]> = [],
  lineOffset = 0,
): boolean {
  const context = state.context ?? openingRawHtmlContext(line);
  if (!context) {
    return false;
  }
  const start = line.length - line.trimStart().length;
  if (!state.context && isInsideMarkdownCode(lineOffset + start, codeSpans)) {
    return false;
  }
  state.context = closesRawHtmlContext(context, line) ? null : context;
  return true;
}

/** Raw ownership ends at the native HTML token, including its enclosing container. */
export function findMarkdownRawHtmlRanges(
  markdown: string,
  markdownParser: MarkdownIt,
): Array<[number, number]> {
  const tokens: DetailsToken[] = [];
  markdownParser.block.parse(markdown, markdownParser, {}, tokens);
  const lineOffsets = [0];
  for (const match of markdown.matchAll(/\n/g)) {
    lineOffsets.push(match.index + 1);
  }
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    if (token.type !== "html_block" || !token.map) {
      continue;
    }
    const rawHtml: MarkdownRawHtmlState = { context: null };
    const lines = token.content.split("\n");
    for (let line = token.map[0]; line < token.map[1]; line += 1) {
      if (!consumeMarkdownRawHtmlLine(lines[line - token.map[0]] ?? "", rawHtml)) {
        continue;
      }
      const start = lineOffsets[line] ?? markdown.length;
      const end = lineOffsets[line + 1] ?? markdown.length;
      const previous = ranges.at(-1);
      if (previous?.[1] === start) {
        previous[1] = end;
      } else {
        ranges.push([start, end]);
      }
    }
  }
  return ranges;
}

export function installMarkdownDetails(markdownParser: MarkdownIt): void {
  markdownParser.block.ruler.before("html_block", "details_block", detailsBlockRule, {
    alt: ["paragraph", "reference", "blockquote"],
  });

  // CommonMark type-6/7 HTML blocks can absorb a later disclosure closer until
  // the next blank line. Continue scanning those blocks while a disclosure is
  // open, but leave raw HTML block types 1-5 entirely literal.
  markdownParser.core.ruler.after("block", "details_balance", (state) => {
    const output: DetailsToken[] = [];
    const stack: MarkdownDetailsFrame[] = [];

    for (const token of state.tokens) {
      if (token.type === "details_open") {
        stack.push({ hasSummary: false });
        output.push(token);
        continue;
      }
      if (token.type === "summary_open") {
        const frame = stack.at(-1);
        if (frame) {
          frame.hasSummary = true;
        }
        output.push(token);
        continue;
      }
      if (token.type === "details_close") {
        stack.pop();
        output.push(token);
        continue;
      }
      if (token.type !== "html_block" || stack.length === 0) {
        output.push(token);
        continue;
      }

      let level = token.level;
      const replacement: DetailsToken[] = [];
      const sink: DetailsTokenSink = {
        push(type, tag, nesting) {
          const next = new state.Token(type, tag, nesting);
          next.block = true;
          if (nesting < 0) {
            level -= 1;
          }
          next.level = level;
          if (nesting > 0) {
            level += 1;
          }
          replacement.push(next);
          return next;
        },
      };
      const lines = token.content.split("\n");
      let pendingHtml = "";
      const rawHtml: MarkdownRawHtmlState = { context: null };
      const flushHtml = () => {
        if (!pendingHtml) {
          return;
        }
        const raw = sink.push("html_block", "", 0);
        raw.content = pendingHtml;
        raw.map = token.map;
        pendingHtml = "";
      };
      for (const [lineOffset, line] of lines.entries()) {
        const hasLineBreak = lineOffset < lines.length - 1;
        if (consumeMarkdownRawHtmlLine(line, rawHtml)) {
          pendingHtml += line + (hasLineBreak ? "\n" : "");
          continue;
        }
        if (!scanMarkdownDisclosureLine(line)) {
          pendingHtml += line + (hasLineBreak ? "\n" : "");
          continue;
        }
        flushHtml();
        const lineNumber = (token.map?.[0] ?? 0) + lineOffset;
        pushDisclosureLine(sink, line, lineNumber, stack);
      }
      flushHtml();
      output.push(...replacement);
    }

    // Streaming can end with open details; balance only our structured tokens at EOF.
    while (stack.length > 0) {
      const token = new state.Token("details_close", "details", -1);
      token.block = true;
      output.push(token);
      stack.pop();
    }
    let level = 0;
    for (const token of output) {
      if (token.nesting < 0) {
        level -= 1;
      }
      token.level = level;
      if (token.nesting > 0) {
        level += 1;
      }
    }
    state.tokens = output;
  });

  markdownParser.renderer.rules.details_open = (tokens, index) =>
    tokens[index]?.attrGet("open") === null ? "<details>" : "<details open>";
  markdownParser.renderer.rules.details_close = () => "</details>\n";
  markdownParser.renderer.rules.summary_open = () => "<summary>";
  markdownParser.renderer.rules.summary_close = () => "</summary>";
}
