import "./markdown-math-element.ts";
import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";
import {
  findMarkdownCodeSpans,
  isInsideCode,
} from "../../../packages/markdown-core/src/reasoning-tag-parser.js";

const DISPLAY_DELIMITERS = [
  { open: "$$", close: "$$", displayMode: true },
  { open: "\\[", close: "\\]", displayMode: true },
] as const;
const INLINE_DELIMITERS = [
  { open: "$$", close: "$$", displayMode: true },
  { open: "\\[", close: "\\]", displayMode: true },
  { open: "\\(", close: "\\)", displayMode: false },
  { open: "$", close: "$", displayMode: false },
] as const;

export const MAX_MATH_SCAN = 4096;
const MAX_MATH_EXPRESSIONS = 200;
let renderedMathExpressions = 0;
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<]*/giu;

function renderMath(source: string, displayMode: boolean): string {
  const delimiter = displayMode ? "$$" : "$";
  const literal = escapeMathFallback(delimiter + source + delimiter);
  if (renderedMathExpressions >= MAX_MATH_EXPRESSIONS) {
    return literal;
  }
  renderedMathExpressions += 1;
  // HTML caches retain this leaf, not a load-state-dependent literal snapshot.
  // Every Markdown surface gets the same connected lifecycle without a host directive.
  return `<openclaw-markdown-math data-display="${displayMode}">${literal}</openclaw-markdown-math>`;
}

function escapeMathFallback(source: string): string {
  return source.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function findUnescapedMathDelimiter(source: string, needle: string, start: number): number {
  const end = Math.min(source.length, start + MAX_MATH_SCAN);
  for (let index = start; index < end; index += 1) {
    if (source[index] !== needle[0] || !source.startsWith(needle, index)) {
      continue;
    }
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      return index;
    }
  }
  return -1;
}

// Inline states own one source string; reuse its URL ranges across delimiter probes.
const bareUrlRanges = new WeakMap<StateInline, Array<readonly [number, number]>>();
const codeSpanRanges = new WeakMap<StateInline, Array<[number, number]>>();

function isInsideCodeSpan(state: StateInline, position: number): boolean {
  let ranges = codeSpanRanges.get(state);
  if (!ranges) {
    ranges = findMarkdownCodeSpans(state.src);
    codeSpanRanges.set(state, ranges);
  }
  return isInsideCode(position, ranges);
}

function isInsideBareUrl(state: StateInline, position: number): boolean {
  let ranges = bareUrlRanges.get(state);
  if (!ranges) {
    ranges = [];
    BARE_URL_RE.lastIndex = 0;
    for (const match of state.src.matchAll(BARE_URL_RE)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    bareUrlRanges.set(state, ranges);
  }
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const [start, end] = ranges[middle]!;
    if (position < start) {
      high = middle;
    } else if (position >= end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function parseDisplayMath(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  const lineStart = state.bMarks[startLine]! + state.tShift[startLine]!;
  const lineEnd = state.eMarks[startLine]!;
  const line = state.src.slice(lineStart, lineEnd);
  const delimiter = DISPLAY_DELIMITERS.find(({ open }) => line.startsWith(open));
  if (!delimiter) {
    return false;
  }
  const afterOpen = line.slice(delimiter.open.length);
  const sameLineClose = findUnescapedMathDelimiter(afterOpen, delimiter.close, 0);
  let nextLine = startLine;
  let latex: string;
  if (sameLineClose >= 0) {
    if (afterOpen.slice(sameLineClose + delimiter.close.length).trim()) {
      return false;
    }
    latex = afterOpen.slice(0, sameLineClose).trim();
  } else {
    const lines: string[] = [afterOpen];
    const scanEnd = Math.min(state.src.length, lineStart + delimiter.open.length + MAX_MATH_SCAN);
    let closeLine = -1;
    for (let lineIndex = startLine + 1; lineIndex < endLine; lineIndex += 1) {
      const currentStart = state.bMarks[lineIndex]! + state.tShift[lineIndex]!;
      // Bound the complete block search, not each line independently: repeated
      // unmatched openers must not rescan the entire remaining document.
      if (currentStart >= scanEnd) {
        break;
      }
      const current = state.src.slice(currentStart, state.eMarks[lineIndex]!);
      const close = findUnescapedMathDelimiter(current, delimiter.close, 0);
      if (close >= 0 && currentStart + close < scanEnd) {
        if (current.slice(close + delimiter.close.length).trim()) {
          return false;
        }
        lines.push(current.slice(0, close));
        closeLine = lineIndex;
        break;
      }
      lines.push(current);
    }
    if (closeLine < 0) {
      return false;
    }
    latex = lines.join("\n").trim();
    nextLine = closeLine;
  }
  if (!latex || silent) {
    return Boolean(latex);
  }
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = latex;
  token.map = [startLine, nextLine + 1];
  token.meta = { displayMode: delimiter.displayMode };
  state.line = nextLine + 1;
  return true;
}

function parseInlineMath(state: StateInline, silent: boolean): boolean {
  const source = state.src.slice(state.pos);
  const delimiter = INLINE_DELIMITERS.find(({ open }) => source.startsWith(open));
  if (!delimiter) {
    return false;
  }
  if (isInsideBareUrl(state, state.pos)) {
    return false;
  }
  const contentStart = delimiter.open.length;
  const close = findUnescapedMathDelimiter(source, delimiter.close, contentStart);
  if (close <= contentStart) {
    return false;
  }
  if (
    delimiter.open === "$" &&
    (/\s/u.test(source.charAt(contentStart)) ||
      /\s/u.test(source.charAt(close - 1)) ||
      /^(?:-\$?\d|\d)/u.test(source.slice(close + delimiter.close.length)) ||
      /\d-$/u.test(state.src.slice(0, state.pos)))
  ) {
    return false;
  }
  if (
    isInsideBareUrl(state, state.pos + close) ||
    (source.slice(contentStart, close).includes("`") && isInsideCodeSpan(state, state.pos + close))
  ) {
    // Reject cheap currency shapes first. Only ambiguous candidates need code ownership.
    return false;
  }
  state.pos += close + delimiter.close.length;
  if (silent) {
    return true;
  }
  const token = state.push("math_inline", "span", 0);
  token.content = source.slice(contentStart, close);
  token.meta = { displayMode: delimiter.displayMode };
  return true;
}

export function installMarkdownMath(markdownParser: MarkdownIt) {
  markdownParser.core.ruler.before("normalize", "math_budget", () => {
    renderedMathExpressions = 0;
  });
  markdownParser.block.ruler.before("paragraph", "math_block", parseDisplayMath, {
    alt: ["paragraph"],
  });
  markdownParser.inline.ruler.before("escape", "math_inline", parseInlineMath);
  markdownParser.renderer.rules.math_inline = (tokens, index) => {
    const token = tokens[index];
    return token ? renderMath(token.content, Boolean(token.meta?.displayMode)) : "";
  };
  markdownParser.renderer.rules.math_block = (tokens, index) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    return renderMath(token.content, true);
  };
}
