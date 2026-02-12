import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Clamp each rendered line to at most `width` visible columns.
 *
 * This is a defensive safeguard against edge-cases where the upstream
 * pi-tui word-wrapping or padding logic produces a line that is wider
 * than the terminal.  Without this the TUI would crash with
 * "Rendered line exceeds terminal width".
 *
 * @see https://github.com/openclaw/openclaw/issues/14591
 */
export function clampLinesToWidth(lines: string[], width: number): string[] {
  for (let i = 0; i < lines.length; i++) {
    if (visibleWidth(lines[i]) > width) {
      lines[i] = truncateToWidth(lines[i], width, "");
    }
  }
  return lines;
}
