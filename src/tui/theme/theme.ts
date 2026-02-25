import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
  TUI,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";
import { createSyntaxTheme, applySyntaxThemeVariant } from "./syntax-theme.js";

// ── Palette types ──

export type ThemePalette = {
  text: string;
  dim: string;
  accent: string;
  accentSoft: string;
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
  terminalBg: string | null;
};

// ── Theme definitions ──

const themes: Record<string, ThemePalette> = {
  default: {
    text: "#E8E3D5", dim: "#7B7F87", accent: "#F6C453", accentSoft: "#F2A65A",
    border: "#3C414B", userBg: "#2B2F36", userText: "#F3EEE0", systemText: "#9BA3B2",
    toolPendingBg: "#1F2A2F", toolSuccessBg: "#1E2D23", toolErrorBg: "#2F1F1F",
    toolTitle: "#F6C453", toolOutput: "#E1DACB", quote: "#8CC8FF", quoteBorder: "#3B4D6B",
    code: "#F0C987", codeBlock: "#1E232A", codeBorder: "#343A45",
    link: "#7DD3A5", error: "#F97066", success: "#7DD3A5", terminalBg: null,
  },
  matrix: {
    text: "#00FF41", dim: "#007A1F", accent: "#00FF41", accentSoft: "#39FF14",
    border: "#004400", userBg: "#001100", userText: "#00FF41", systemText: "#006400",
    toolPendingBg: "#001A00", toolSuccessBg: "#002200", toolErrorBg: "#1A0000",
    toolTitle: "#39FF14", toolOutput: "#00CC33", quote: "#00BB55", quoteBorder: "#003300",
    code: "#ADFF2F", codeBlock: "#0A1200", codeBorder: "#003B00",
    link: "#00FF88", error: "#FF0000", success: "#00FF41", terminalBg: "#000000",
  },
  "one-dark": {
    text: "#ABB2BF", dim: "#5C6370", accent: "#61AFEF", accentSoft: "#56B6C2",
    border: "#3E4451", userBg: "#2C313A", userText: "#ABB2BF", systemText: "#5C6370",
    toolPendingBg: "#21252B", toolSuccessBg: "#1D2B1D", toolErrorBg: "#2B1D1D",
    toolTitle: "#E5C07B", toolOutput: "#ABB2BF", quote: "#61AFEF", quoteBorder: "#264F78",
    code: "#E5C07B", codeBlock: "#21252B", codeBorder: "#3E4451",
    link: "#98C379", error: "#E06C75", success: "#98C379", terminalBg: "#282C34",
  },
  "retro-crt": {
    text: "#FFB000", dim: "#7A5500", accent: "#FF8C00", accentSoft: "#FFA500",
    border: "#5C3D00", userBg: "#2A1A00", userText: "#FFD700", systemText: "#AA7700",
    toolPendingBg: "#1A1000", toolSuccessBg: "#1A1A00", toolErrorBg: "#2A0A00",
    toolTitle: "#FF8C00", toolOutput: "#FFB000", quote: "#FFA500", quoteBorder: "#5C3D00",
    code: "#FFCC00", codeBlock: "#1A1000", codeBorder: "#5C3D00",
    link: "#FFD700", error: "#FF4500", success: "#9ACD32", terminalBg: "#1A0F00",
  },
  light: {
    text: "#111111", dim: "#444444", accent: "#4A3DB0", accentSoft: "#6355C0",
    border: "#8878B0", userBg: "#D8CFF0", userText: "#111111", systemText: "#333333",
    toolPendingBg: "#C0D8F0", toolSuccessBg: "#C0E0C8", toolErrorBg: "#F0C0C0",
    toolTitle: "#3A2E90", toolOutput: "#1a1a1a", quote: "#3A2E90", quoteBorder: "#6858A0",
    code: "#991850", codeBlock: "#E0D8F0", codeBorder: "#8878B0",
    link: "#186848", error: "#A01030", success: "#186848", terminalBg: "#F5F2FA",
  },
  synthwave: {
    text: "#F8F8F2", dim: "#6272A4", accent: "#FF79C6", accentSoft: "#BD93F9",
    border: "#44475A", userBg: "#282A36", userText: "#F8F8F2", systemText: "#6272A4",
    toolPendingBg: "#1E1F29", toolSuccessBg: "#1A2B1A", toolErrorBg: "#2A1020",
    toolTitle: "#FF79C6", toolOutput: "#F8F8F2", quote: "#8BE9FD", quoteBorder: "#44475A",
    code: "#50FA7B", codeBlock: "#1E1F29", codeBorder: "#44475A",
    link: "#8BE9FD", error: "#FF5555", success: "#50FA7B", terminalBg: "#1a0a2e",
  },
};

// ── Mutable state ──

export let palette: ThemePalette = { ...themes.default };
export let currentThemeName = "default";

// ── Color helpers ──

export const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
export const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

// ── Syntax highlighting ──

const syntaxTheme = createSyntaxTheme(fg(palette.code));

const LIGHT_THEMES = new Set(["light"]);

function highlightCode(code: string, lang?: string): string[] {
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    // Wrap each line in palette.code so unstyled tokens (parens, colons, etc.) are readable
    return highlighted.split("\n").map((line) => fg(palette.code)(line));
  } catch {
    return code.split("\n").map((line) => fg(palette.code)(line));
  }
}

// ── Theme objects ──

export const theme = {
  fg: fg(palette.text),
  assistantText: fg(palette.text),
  dim: fg(palette.dim),
  accent: fg(palette.accent),
  accentSoft: fg(palette.accentSoft),
  success: fg(palette.success),
  error: fg(palette.error),
  header: (text: string) => chalk.bold(fg(palette.accent)(text)),
  system: fg(palette.systemText),
  userBg: bg(palette.userBg),
  userText: fg(palette.userText),
  toolTitle: fg(palette.toolTitle),
  toolOutput: fg(palette.toolOutput),
  toolPendingBg: bg(palette.toolPendingBg),
  toolSuccessBg: bg(palette.toolSuccessBg),
  toolErrorBg: bg(palette.toolErrorBg),
  border: fg(palette.border),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(fg(palette.accent)(text)),
  link: (text) => fg(palette.link)(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => fg(palette.code)(text),
  codeBlock: (text) => fg(palette.code)(text),
  codeBlockBorder: (text) => fg(palette.codeBorder)(text),
  quote: (text) => fg(palette.quote)(text),
  quoteBorder: (text) => fg(palette.quoteBorder)(text),
  hr: (text) => fg(palette.border)(text),
  listBullet: (text) => fg(palette.accentSoft)(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode,
};

const baseSelectListTheme: SelectListTheme = {
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
  description: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
};

export const selectListTheme: SelectListTheme = baseSelectListTheme;

export const filterableSelectListTheme = {
  ...baseSelectListTheme,
  filterLabel: (text: string) => fg(palette.dim)(text),
};

export const settingsListTheme: SettingsListTheme = {
  label: (text, selected) =>
    selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text),
  value: (text, selected) => (selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text)),
  description: (text) => fg(palette.systemText)(text),
  cursor: fg(palette.accent)("→ "),
  hint: (text) => fg(palette.dim)(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg(palette.border)(text),
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  ...baseSelectListTheme,
  searchPrompt: (text) => fg(palette.accentSoft)(text),
  searchInput: (text) => fg(palette.text)(text),
  matchHighlight: (text) => chalk.bold(fg(palette.accent)(text)),
};

// ── Theme API ──

export function getThemeNames(): string[] {
  return Object.keys(themes);
}

/**
 * Apply a theme by name. Rebuilds all theme objects and updates terminal colors.
 * Returns true if theme was found, false otherwise.
 */
export function applyTheme(name: string, tui?: TUI): boolean {
  const t = themes[name];
  if (!t) return false;

  Object.assign(palette, t);
  currentThemeName = name;

  // Rebuild theme object
  theme.fg = fg(palette.text);
  theme.assistantText = fg(palette.text);
  theme.dim = fg(palette.dim);
  theme.accent = fg(palette.accent);
  theme.accentSoft = fg(palette.accentSoft);
  theme.success = fg(palette.success);
  theme.error = fg(palette.error);
  theme.header = (text: string) => chalk.bold(fg(palette.accent)(text));
  theme.system = fg(palette.systemText);
  theme.userBg = bg(palette.userBg);
  theme.userText = fg(palette.userText);
  theme.toolTitle = fg(palette.toolTitle);
  theme.toolOutput = fg(palette.toolOutput);
  theme.toolPendingBg = bg(palette.toolPendingBg);
  theme.toolSuccessBg = bg(palette.toolSuccessBg);
  theme.toolErrorBg = bg(palette.toolErrorBg);
  theme.border = fg(palette.border);

  // Rebuild markdownTheme
  markdownTheme.heading = (text) => chalk.bold(fg(palette.accent)(text));
  markdownTheme.link = (text) => fg(palette.link)(text);
  markdownTheme.code = (text) => fg(palette.code)(text);
  markdownTheme.codeBlock = (text) => fg(palette.code)(text);
  markdownTheme.codeBlockBorder = (text) => fg(palette.codeBorder)(text);
  markdownTheme.quote = (text) => fg(palette.quote)(text);
  markdownTheme.quoteBorder = (text) => fg(palette.quoteBorder)(text);
  markdownTheme.hr = (text) => fg(palette.border)(text);
  markdownTheme.listBullet = (text) => fg(palette.accentSoft)(text);
  markdownTheme.highlightCode = highlightCode;

  // Rebuild selectListTheme
  selectListTheme.selectedPrefix = (text) => fg(palette.accent)(text);
  selectListTheme.selectedText = (text) => chalk.bold(fg(palette.accent)(text));
  selectListTheme.description = (text) => fg(palette.dim)(text);
  selectListTheme.scrollInfo = (text) => fg(palette.dim)(text);
  selectListTheme.noMatch = (text) => fg(palette.dim)(text);

  // Rebuild searchableSelectListTheme
  searchableSelectListTheme.searchPrompt = (text) => fg(palette.accentSoft)(text);
  searchableSelectListTheme.searchInput = (text) => fg(palette.text)(text);
  searchableSelectListTheme.matchHighlight = (text) => chalk.bold(fg(palette.accent)(text));

  // Rebuild editorTheme
  editorTheme.borderColor = (text) => fg(palette.border)(text);

  // Rebuild settingsListTheme
  settingsListTheme.label = (text, selected) =>
    selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text);
  settingsListTheme.value = (text, selected) =>
    selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text);
  settingsListTheme.description = (text) => fg(palette.systemText)(text);
  settingsListTheme.cursor = fg(palette.accent)("→ ");
  settingsListTheme.hint = (text) => fg(palette.dim)(text);

  // Update syntax theme for light/dark
  const isLight = LIGHT_THEMES.has(name);
  applySyntaxThemeVariant(syntaxTheme, isLight, fg(palette.code));

  // Terminal foreground via OSC 10
  process.stdout.write(`\x1b]10;${palette.text}\x07`);

  // Terminal background via OSC 11
  if (t.terminalBg) {
    process.stdout.write(`\x1b]11;${t.terminalBg}\x07`);
  } else {
    process.stdout.write("\x1b]110\x07");
  }

  if (tui) tui.requestRender();
  return true;
}

/**
 * Reset terminal foreground and background to defaults.
 * Call this before exiting the TUI.
 */
export function resetTerminalColors(): void {
  process.stdout.write("\x1b]110\x07\x1b]111\x07");
}

/**
 * Set initial terminal colors based on current palette.
 * Call this after tui.start().
 */
export function applyInitialTerminalColors(): void {
  if (palette.terminalBg) {
    process.stdout.write(`\x1b]10;${palette.text}\x07`);
    process.stdout.write(`\x1b]11;${palette.terminalBg}\x07`);
  }
}
