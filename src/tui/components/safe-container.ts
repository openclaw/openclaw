import { Container, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * A Container that truncates any rendered line exceeding the given width.
 * Used as the TUI root to prevent pi-tui's hard crash when a line is even
 * 1 character over the terminal width (see #17525).
 */
export class SafeContainer extends Container {
  render(width: number): string[] {
    const lines = super.render(width);
    for (let i = 0; i < lines.length; i++) {
      if (visibleWidth(lines[i]) > width) {
        lines[i] = truncateToWidth(lines[i], width, "");
      }
    }
    return lines;
  }
}
