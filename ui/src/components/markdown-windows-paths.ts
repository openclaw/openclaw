import type { MarkdownIt } from "markdown-it";

// A pasted Windows path is literal text: `C:\Users\me\.config` must not lose the
// backslash that Markdown would otherwise read as an escape before `.` or `_`.
const WINDOWS_PATH_START_RE = /^[("'[<]?(?:[A-Za-z]:[\\/]|\\\\[^\s\\/])/;
const ASCII_PUNCTUATION_RE = /^[!-/:-@[-`{-~]$/;

/** Keep backslashes inside plain-text Windows paths instead of treating them as escapes. */
export function installMarkdownWindowsPaths(markdownParser: MarkdownIt): void {
  markdownParser.inline.ruler.before("escape", "windows_path_backslash", (state, silent) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 0x5c) {
      return false;
    }
    let start = pos;
    while (start > 0 && !/\s/.test(src[start - 1] ?? "")) {
      start--;
    }
    // The path token starts with a drive or UNC root; three characters cover a separator at pos.
    if (!WINDOWS_PATH_START_RE.test(src.slice(start, pos + 3))) {
      return false;
    }
    // The separator owns the punctuation after it, so `\_cache_` cannot open emphasis.
    const length = ASCII_PUNCTUATION_RE.test(src[pos + 1] ?? "") ? 2 : 1;
    if (!silent) {
      state.pending += src.slice(pos, pos + length);
    }
    state.pos += length;
    return true;
  });
}
