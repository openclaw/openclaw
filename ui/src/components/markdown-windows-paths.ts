import type { MarkdownIt } from "markdown-it";

// A pasted Windows path is literal text: `C:\Users\me\.config` must not lose the
// backslash that Markdown would otherwise read as an escape before `.` or `_`.
const DRIVE_PATH_PREFIX_RE = /^[("'[<]?[A-Za-z]:(?:[\\/]|$)/;
const UNC_PATH_PREFIX_RE = /^[("'[<]?\\\\[^\s\\/]/;
const UNC_PATH_START_RE = /^\\\\[^\s\\/]/;
const ASCII_PUNCTUATION_RE = /^[!-/:-@[-`{-~]$/;

function isWindowsPathBackslash(src: string, pos: number): boolean {
  let start = pos;
  while (start > 0 && !/\s/.test(src[start - 1] ?? "")) {
    start--;
  }
  const prefix = src.slice(start, pos);
  if (DRIVE_PATH_PREFIX_RE.test(prefix) || UNC_PATH_PREFIX_RE.test(prefix)) {
    return true;
  }
  // The first separator of a UNC path (`\\server\share`) starts its token.
  return /^[("'[<]?$/.test(prefix) && UNC_PATH_START_RE.test(src.slice(pos));
}

/** Keep backslashes inside plain-text Windows paths instead of treating them as escapes. */
export function installMarkdownWindowsPaths(markdownParser: MarkdownIt): void {
  markdownParser.inline.ruler.before("escape", "windows_path_backslash", (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x5c || !isWindowsPathBackslash(state.src, state.pos)) {
      return false;
    }
    // The separator owns the punctuation after it, so `\_cache_` cannot open emphasis.
    const next = state.src[state.pos + 1] ?? "";
    const length = ASCII_PUNCTUATION_RE.test(next) ? 2 : 1;
    if (!silent) {
      state.pending += state.src.slice(state.pos, state.pos + length);
    }
    state.pos += length;
    return true;
  });
}
