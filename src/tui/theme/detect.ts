/**
 * Detect terminal background brightness to auto-select a theme.
 *
 * Resolution order:
 *   1. `OPENCLAW_THEME` env var (exact theme name)
 *   2. `COLORFGBG` env var (heuristic: bg color index >= 8 → dark)
 *   3. Default to "dark"
 */

export function detectThemeName(): string {
  const explicit = process.env.OPENCLAW_THEME?.trim();
  if (explicit) {
    return explicit;
  }

  const colorFgBg = process.env.COLORFGBG?.trim();
  if (colorFgBg) {
    // COLORFGBG format is "fg;bg" where values are ANSI color indices.
    // Low bg values (0-6) are dark colors, high values (7+) are light.
    const parts = colorFgBg.split(";");
    const bg = Number.parseInt(parts[parts.length - 1] ?? "", 10);
    if (!Number.isNaN(bg) && bg >= 7 && bg <= 15) {
      // bg index 7 is light gray, 15 is white — treat as light terminal.
      // bg index 7 specifically is ambiguous; some terminals use it for
      // a light background. We lean toward "light" since dark-theme
      // terminals rarely set bg=7.
      return "light";
    }
  }

  return "dark";
}
