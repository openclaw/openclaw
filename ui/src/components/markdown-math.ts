import type { MarkdownIt } from "markdown-it";

// TeX row breaks and escaped dollar signs do not close a math expression.
export function findMarkdownMathClosingDelimiter(
  source: string,
  delimiter: string,
  from: number,
): number {
  for (
    let end = source.indexOf(delimiter, from);
    end >= 0;
    end = source.indexOf(delimiter, end + 1)
  ) {
    let backslashes = 0;
    for (let i = end - 1; i >= 0 && source[i] === "\\"; i--) {
      backslashes++;
    }
    if (backslashes % 2 === 0) {
      return end;
    }
  }
  return -1;
}

/** Recognize explicit TeX delimiters without interpreting currency as math. */
export function installMarkdownMath(markdown: MarkdownIt): void {
  markdown.inline.ruler.before("escape", "math_inline", (state, silent) => {
    const rest = state.src.slice(state.pos, state.posMax);
    const opening = rest.startsWith("\\(")
      ? "\\("
      : rest.startsWith("\\[")
        ? "\\["
        : rest.startsWith("$$")
          ? "$$"
          : null;
    if (!opening) {
      return false;
    }
    const closing = opening === "\\(" ? "\\)" : opening === "\\[" ? "\\]" : "$$";
    const end = findMarkdownMathClosingDelimiter(rest, closing, opening.length);
    if (end < 0) {
      return false;
    }
    if (!silent) {
      const token = state.push("math_inline", "openclaw-math", 0);
      token.content = rest.slice(opening.length, end);
      token.attrSet(
        "class",
        opening === "\\(" ? "markdown-math" : "markdown-math markdown-math-display",
      );
    }
    state.pos += end + closing.length;
    return true;
  });
  markdown.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) {
        return false;
      }
      const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
      if (!state.src.startsWith("$$", start) && !state.src.startsWith("\\[", start)) {
        return false;
      }
      const source = state.getLines(startLine, endLine, state.blkIndent, false);
      const opening = state.src.startsWith("$$", start) ? "$$" : "\\[";
      const closing = opening === "$$" ? "$$" : "\\]";
      const contentStart = source.indexOf(opening) + opening.length;
      const end = findMarkdownMathClosingDelimiter(source, closing, contentStart);
      if (end < 0) {
        return false;
      }
      const trailing = /^[ \t]*(?:\n|$)/u.exec(source.slice(end + closing.length));
      if (!trailing) {
        return false;
      }
      if (silent) {
        return true;
      }
      const consumed = source.slice(0, end + closing.length + trailing[0].length);
      const lines = consumed.split("\n").length - (consumed.endsWith("\n") ? 1 : 0);
      const token = state.push("math_block", "openclaw-math", 0);
      token.block = true;
      token.content = source.slice(contentStart, end);
      token.map = [startLine, startLine + lines];
      token.attrSet("class", "markdown-math markdown-math-display");
      state.line = startLine + lines;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
  const render: NonNullable<typeof markdown.renderer.rules.math_inline> = (tokens, index) => {
    const token = tokens[index]!;
    return `<openclaw-math class="${token.attrGet("class")}">${markdown.utils.escapeHtml(token.content)}</openclaw-math>${token.block ? "\n" : ""}`;
  };
  markdown.renderer.rules.math_inline = render;
  markdown.renderer.rules.math_block = render;
}
