import "./markdown-math-element.ts";
import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";
import { isMarkdownFenceOpener } from "../../../packages/markdown-core/src/fences.js";
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/markdown-code-regions.js";
import { isInsideCode as isInsideSpan } from "../../../packages/markdown-core/src/reasoning-tag-syntax.js";

export const MAX_MATH_SCAN = 4096;
const MAX_MATH_EXPRESSIONS = 200;
export type MarkdownMathBudget = { rendered: number };
declare module "markdown-it" {
  interface Env {
    mathBudget?: MarkdownMathBudget;
  }
}
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<]*/giu;

export function displayMathCloser(source: string): "$$" | "\\]" | null {
  return source.startsWith("$$") ? "$$" : source.startsWith("\\[") ? "\\]" : null;
}

function renderMath(
  source: string,
  displayMode: boolean,
  budget: MarkdownMathBudget = { rendered: 0 },
): string {
  const literal = escapeMathFallback(displayMode ? `$$${source}$$` : `\\(${source}\\)`);
  if (budget.rendered >= MAX_MATH_EXPRESSIONS) {
    return literal;
  }
  budget.rendered += 1;
  // HTML caches retain this leaf, not a load-state-dependent literal snapshot.
  // Every Markdown surface gets the same connected lifecycle without a host directive.
  // Not every browser makes horizontal overflow containers keyboard-focusable.
  const tabIndex = displayMode ? ' tabindex="0"' : "";
  return `<openclaw-markdown-math data-display="${displayMode}"${tabIndex}>${literal}</openclaw-markdown-math>`;
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

// Inline states own one source string; reuse its ranges across delimiter probes.
const inlineRanges = new WeakMap<
  StateInline,
  { urls: Array<[number, number]>; code?: Array<[number, number]> }
>();

function parseDisplayMath(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  const lineStart = state.bMarks[startLine]! + state.tShift[startLine]!;
  const afterOpen = lineStart + 2;
  const closer = displayMathCloser(state.src.slice(lineStart, afterOpen));
  if (!closer) {
    return false;
  }
  // Bound the complete block search, not each line independently: repeated
  // unmatched openers must not rescan the entire remaining document.
  const scanEnd = afterOpen + MAX_MATH_SCAN;
  let content = "";
  for (let lineIndex = startLine; lineIndex < endLine; lineIndex += 1) {
    const firstLine = lineIndex === startLine;
    const currentStart = firstLine
      ? afterOpen
      : state.bMarks[lineIndex]! + state.tShift[lineIndex]!;
    if (currentStart >= scanEnd) {
      return false;
    }
    const current = state.src.slice(currentStart, state.eMarks[lineIndex]!);
    if (
      !firstLine &&
      state.sCount[lineIndex]! - state.blkIndent < 4 &&
      isMarkdownFenceOpener(current)
    ) {
      return false;
    }
    const close = findUnescapedMathDelimiter(current, closer, 0);
    if (close < 0 || currentStart + close >= scanEnd) {
      content += current + "\n";
      continue;
    }
    if (current.slice(close + 2).trim()) {
      return false;
    }
    const latex = (content + current.slice(0, close)).trim();
    if (!latex || silent) {
      return Boolean(latex);
    }
    const token = state.push("math_block", "div", 0);
    token.block = true;
    token.content = latex;
    token.map = [startLine, lineIndex + 1];
    state.line = lineIndex + 1;
    return true;
  }
  return false;
}

function parseInlineMath(state: StateInline, silent: boolean): boolean {
  const source = state.src.slice(state.pos, state.posMax);
  const closer = displayMathCloser(source) ?? (source.startsWith("\\(") ? "\\)" : null);
  if (!closer) {
    return false;
  }
  let ranges = inlineRanges.get(state);
  if (!ranges) {
    ranges = {
      urls: Array.from(state.src.matchAll(BARE_URL_RE), (match) => [
        match.index,
        match.index + match[0].length,
      ]),
    };
    inlineRanges.set(state, ranges);
  }
  if (isInsideSpan(state.pos, ranges.urls)) {
    return false;
  }
  const close = findUnescapedMathDelimiter(source, closer, 2);
  if (close <= 2) {
    return false;
  }
  const latex = source.slice(2, close);
  if (
    isInsideSpan(state.pos + close, ranges.urls) ||
    (latex.includes("`") &&
      isInsideSpan(state.pos + close, (ranges.code ??= findMarkdownCodeSpans(state.src))))
  ) {
    return false;
  }
  if (silent && latex.includes("]")) {
    // Link-label lookahead must see its closing bracket before tokenizing the label.
    let braces = 0;
    let brackets = 0;
    let groupedLabelEnd = false;
    for (const { 0: character, index } of latex.matchAll(/\\[\s\S]|[[\]{}]/gu)) {
      const linkEnd = character === "]" && (latex[index + 1] === "(" || latex[index + 1] === "[");
      if (character === "{") {
        braces += 1;
      } else if (character === "}") {
        braces = Math.max(0, braces - 1);
        if (braces === 0) {
          groupedLabelEnd = false;
        }
      }
      if (braces > 0) {
        groupedLabelEnd ||= linkEnd;
        continue;
      }
      if (character === "[") {
        brackets += 1;
      } else if (character === "]") {
        if (brackets > 0) {
          brackets -= 1;
        } else if (linkEnd) {
          return false;
        }
      }
    }
    if (groupedLabelEnd) {
      return false;
    }
  }
  state.pos += close + 2;
  if (silent) {
    return true;
  }
  const token = state.push("math_inline", "span", 0);
  token.content = latex;
  token.meta = { displayMode: closer !== "\\)" };
  return true;
}

export function installMarkdownMath(markdownParser: MarkdownIt) {
  markdownParser.core.ruler.before("normalize", "math_budget", (state) => {
    state.env.mathBudget ??= { rendered: 0 };
  });
  markdownParser.block.ruler.before("paragraph", "math_block", parseDisplayMath, {
    alt: ["paragraph"],
  });
  markdownParser.inline.ruler.before("escape", "math_inline", parseInlineMath);
  const rules = markdownParser.renderer.rules;
  rules.math_inline = rules.math_block = (tokens, index, _options, env) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    return (
      renderMath(token.content, token.block || token.meta?.displayMode === true, env?.mathBudget) +
      (token.block ? "\n" : "")
    );
  };
}
