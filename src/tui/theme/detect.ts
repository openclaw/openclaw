/**
 * Detect terminal background brightness to auto-select a theme.
 *
 * Resolution order:
 *   1. `OPENCLAW_THEME` env var (exact theme name)
 *   2. `COLORFGBG` env var (heuristic: high bg index → light)
 *   3. Default to "dark"
 */

export function detectThemeName(): string {
  const explicit = process.env.OPENCLAW_THEME?.trim();
  if (explicit) {
    return explicit;
  }

  const colorFgBg = process.env.COLORFGBG?.trim();
  if (colorFgBg) {
    // COLORFGBG format is "fg;bg" where values are ANSI color indices (0-15).
    // Indices 0-7 are the standard colors, 8-15 are bright variants.
    //
    // We only treat high-end values as "light":
    //   - 7  = silver/light gray — ambiguous but commonly light
    //   - 15 = white — definitely light
    //
    // Indices 8-14 include bright black (dark gray) through bright cyan,
    // which are commonly used in dark terminal themes, so we do NOT
    // treat those as light to avoid false positives.
    const parts = colorFgBg.split(";");
    const bg = Number.parseInt(parts[parts.length - 1] ?? "", 10);
    if (!Number.isNaN(bg) && (bg === 7 || bg === 15)) {
      return "light";
    }
  }

  return "dark";
}
