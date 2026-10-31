import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";

type Terminal = GhosttyTerminalController["terminal"];
export type TerminalFindMatch = { row: number; start: number; line: string };

/** Search retained visual rows, without interpreting output or sending terminal input. */
export function findTerminalMatches(terminal: Terminal, query: string): TerminalFindMatch[] {
  const engine = terminal.wasmTerm;
  if (!query || !engine) {
    return [];
  }
  const buffer = terminal.buffer.active;
  const scrollback = engine.isAlternateScreen() ? 0 : engine.getScrollbackLength();
  const matches: TerminalFindMatch[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const historical = row < scrollback;
    const source = historical ? engine.getScrollbackLine(row) : engine.getLine(row - scrollback);
    if (!source) {
      continue;
    }
    let line = "";
    let end = source.length;
    // Unused padding is not printed whitespace; keep real trailing spaces.
    while (end && source[end - 1]?.codepoint === 0 && source[end - 1]?.width !== 0) {
      end--;
    }
    for (let column = 0; column < end; column++) {
      const cell = source[column];
      if (!cell || cell.width === 0) {
        continue;
      }
      line +=
        cell.grapheme_len > 0
          ? historical
            ? engine.getScrollbackGraphemeString(row, column)
            : engine.getGraphemeString(row - scrollback, column)
          : cell.codepoint
            ? String.fromCodePoint(cell.codepoint)
            : " ";
    }
    for (
      let start = line.indexOf(query);
      start !== -1;
      start = line.indexOf(query, start + query.length)
    ) {
      matches.push({ row, start, line });
    }
  }
  return matches;
}

export function revealTerminalMatch(terminal: Terminal, match: TerminalFindMatch): void {
  // ghostty-web 0.4 uses a distance from the bottom, including in scrollToLine.
  const scrollback = Math.max(0, terminal.buffer.active.length - terminal.rows);
  terminal.scrollToLine(Math.max(0, scrollback - match.row + Math.floor(terminal.rows / 2)));
}
