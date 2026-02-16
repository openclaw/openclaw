/**
 * Theme registry for the TUI.
 *
 * Provides a dynamic palette system that can be swapped at runtime.
 * Components that call `theme.X(text)` automatically pick up changes
 * on the next render cycle because theme functions are rebuilt in-place.
 */

export type TuiThemePalette = {
  text: string;
  dim: string;
  accent: string;
  accentSoft: string;
  accentBright: string;
  border: string;
  userBg: string;
  userText: string;
  systemText: string;
  toolPendingBg: string;
  toolSuccessBg: string;
  toolErrorBg: string;
  toolTitle: string;
  toolOutput: string;
  quote: string;
  quoteBorder: string;
  code: string;
  codeBlock: string;
  codeBorder: string;
  link: string;
  error: string;
  success: string;
};

// ── Built-in Palettes ────────────────────────────────────────────────

const OPENCLAW_PALETTE: TuiThemePalette = {
  text: "#E8E3D5",
  dim: "#7B7F87",
  accent: "#F6C453",
  accentSoft: "#F2A65A",
  accentBright: "#FFD700",
  border: "#3C414B",
  userBg: "#2B2F36",
  userText: "#F3EEE0",
  systemText: "#9BA3B2",
  toolPendingBg: "#1F2A2F",
  toolSuccessBg: "#1E2D23",
  toolErrorBg: "#2F1F1F",
  toolTitle: "#F6C453",
  toolOutput: "#E1DACB",
  quote: "#8CC8FF",
  quoteBorder: "#3B4D6B",
  code: "#F0C987",
  codeBlock: "#1E232A",
  codeBorder: "#343A45",
  link: "#7DD3A5",
  error: "#F97066",
  success: "#7DD3A5",
};

const CLAUDE_PALETTE: TuiThemePalette = {
  text: "#D4D4D4",
  dim: "#6B7280",
  accent: "#A78BFA",
  accentSoft: "#818CF8",
  accentBright: "#C4B5FD",
  border: "#374151",
  userBg: "#1E293B",
  userText: "#E2E8F0",
  systemText: "#9CA3AF",
  toolPendingBg: "#1E1B4B",
  toolSuccessBg: "#14532D",
  toolErrorBg: "#450A0A",
  toolTitle: "#A78BFA",
  toolOutput: "#D1D5DB",
  quote: "#93C5FD",
  quoteBorder: "#1E40AF",
  code: "#C4B5FD",
  codeBlock: "#1E1B3A",
  codeBorder: "#312E81",
  link: "#6EE7B7",
  error: "#F87171",
  success: "#6EE7B7",
};

const MONOKAI_PALETTE: TuiThemePalette = {
  text: "#F8F8F2",
  dim: "#75715E",
  accent: "#F92672",
  accentSoft: "#FD971F",
  accentBright: "#FF6188",
  border: "#49483E",
  userBg: "#3E3D32",
  userText: "#F8F8F2",
  systemText: "#A6A995",
  toolPendingBg: "#272822",
  toolSuccessBg: "#2D3A2D",
  toolErrorBg: "#3A2222",
  toolTitle: "#A6E22E",
  toolOutput: "#E6DB74",
  quote: "#66D9EF",
  quoteBorder: "#3E5F6A",
  code: "#E6DB74",
  codeBlock: "#272822",
  codeBorder: "#49483E",
  link: "#66D9EF",
  error: "#F92672",
  success: "#A6E22E",
};

const SOLARIZED_DARK_PALETTE: TuiThemePalette = {
  text: "#93A1A1",
  dim: "#586E75",
  accent: "#B58900",
  accentSoft: "#CB4B16",
  accentBright: "#FDF6E3",
  border: "#073642",
  userBg: "#073642",
  userText: "#EEE8D5",
  systemText: "#657B83",
  toolPendingBg: "#002B36",
  toolSuccessBg: "#073642",
  toolErrorBg: "#2B1010",
  toolTitle: "#268BD2",
  toolOutput: "#839496",
  quote: "#2AA198",
  quoteBorder: "#073642",
  code: "#859900",
  codeBlock: "#002B36",
  codeBorder: "#073642",
  link: "#2AA198",
  error: "#DC322F",
  success: "#859900",
};

const DRACULA_PALETTE: TuiThemePalette = {
  text: "#F8F8F2",
  dim: "#6272A4",
  accent: "#BD93F9",
  accentSoft: "#FF79C6",
  accentBright: "#D6ACFF",
  border: "#44475A",
  userBg: "#44475A",
  userText: "#F8F8F2",
  systemText: "#6272A4",
  toolPendingBg: "#282A36",
  toolSuccessBg: "#1E3A2D",
  toolErrorBg: "#3A1E1E",
  toolTitle: "#50FA7B",
  toolOutput: "#F1FA8C",
  quote: "#8BE9FD",
  quoteBorder: "#44475A",
  code: "#F1FA8C",
  codeBlock: "#282A36",
  codeBorder: "#44475A",
  link: "#8BE9FD",
  error: "#FF5555",
  success: "#50FA7B",
};

const MINIMAL_PALETTE: TuiThemePalette = {
  text: "#B0B0B0",
  dim: "#606060",
  accent: "#FFFFFF",
  accentSoft: "#A0A0A0",
  accentBright: "#FFFFFF",
  border: "#3A3A3A",
  userBg: "#2A2A2A",
  userText: "#D0D0D0",
  systemText: "#808080",
  toolPendingBg: "#222222",
  toolSuccessBg: "#222822",
  toolErrorBg: "#282222",
  toolTitle: "#D0D0D0",
  toolOutput: "#909090",
  quote: "#A0A0A0",
  quoteBorder: "#3A3A3A",
  code: "#B0B0B0",
  codeBlock: "#1A1A1A",
  codeBorder: "#333333",
  link: "#A0A0A0",
  error: "#E06060",
  success: "#60E060",
};

const HIGH_CONTRAST_PALETTE: TuiThemePalette = {
  text: "#FFFFFF",
  dim: "#AAAAAA",
  accent: "#FFFF00",
  accentSoft: "#FFA500",
  accentBright: "#FFFF00",
  border: "#FFFFFF",
  userBg: "#000080",
  userText: "#FFFFFF",
  systemText: "#CCCCCC",
  toolPendingBg: "#000044",
  toolSuccessBg: "#004400",
  toolErrorBg: "#440000",
  toolTitle: "#00FF00",
  toolOutput: "#FFFFFF",
  quote: "#00FFFF",
  quoteBorder: "#008080",
  code: "#00FF00",
  codeBlock: "#000000",
  codeBorder: "#FFFFFF",
  link: "#00FFFF",
  error: "#FF0000",
  success: "#00FF00",
};

// ── Registry ─────────────────────────────────────────────────────────

const PALETTES: Record<string, TuiThemePalette> = {
  openclaw: OPENCLAW_PALETTE,
  claude: CLAUDE_PALETTE,
  monokai: MONOKAI_PALETTE,
  "solarized-dark": SOLARIZED_DARK_PALETTE,
  dracula: DRACULA_PALETTE,
  minimal: MINIMAL_PALETTE,
  "high-contrast": HIGH_CONTRAST_PALETTE,
};

const DEFAULT_THEME = "openclaw";

let activeThemeName = DEFAULT_THEME;

type PaletteChangeListener = (palette: TuiThemePalette, name: string) => void;
const listeners: PaletteChangeListener[] = [];

/**
 * Get the currently active palette.
 */
export function getActivePalette(): TuiThemePalette {
  return PALETTES[activeThemeName] ?? PALETTES[DEFAULT_THEME];
}

/**
 * Get the name of the currently active theme.
 */
export function getActiveThemeName(): string {
  return activeThemeName;
}

/**
 * List all available theme names.
 */
export function listThemeNames(): string[] {
  return Object.keys(PALETTES);
}

/**
 * Set the active palette by name. Returns true if the theme was found.
 * Notifies all listeners so theme objects can rebuild their functions.
 */
export function setActiveTheme(name: string): boolean {
  const palette = PALETTES[name];
  if (!palette) {
    return false;
  }
  activeThemeName = name;
  for (const listener of listeners) {
    listener(palette, name);
  }
  return true;
}

/**
 * Subscribe to palette changes.
 * Returns an unsubscribe function.
 */
export function onPaletteChange(listener: PaletteChangeListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  };
}

/**
 * Check if a theme name exists in the registry.
 */
export function hasTheme(name: string): boolean {
  return name in PALETTES;
}

/**
 * Get a theme description for display in the selector.
 */
export function getThemeDescription(name: string): string {
  switch (name) {
    case "openclaw":
      return "Default gold/amber theme";
    case "claude":
      return "Blue/purple tones inspired by Claude";
    case "monokai":
      return "Classic warm dark theme";
    case "solarized-dark":
      return "Solarized dark color scheme";
    case "dracula":
      return "Purple/pink dark theme";
    case "minimal":
      return "Minimal grayscale";
    case "high-contrast":
      return "High contrast for accessibility";
    default:
      return "";
  }
}
