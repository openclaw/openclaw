import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";
import type { Palette, ThemePalette } from "./palettes.js";
import { detectThemeName } from "./detect.js";
import { getPalette, palettes } from "./palettes.js";
import { createSyntaxThemeFromPalette } from "./syntax-theme.js";

// ---------------------------------------------------------------------------
// WCAG contrast utilities (from upstream)
// ---------------------------------------------------------------------------

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function channelToSrgb(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminanceRgb(r: number, g: number, b: number): number {
  const red = channelToSrgb(r);
  const green = channelToSrgb(g);
  const blue = channelToSrgb(b);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function relativeLuminanceHex(hex: string): number {
  return relativeLuminanceRgb(
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  );
}

function contrastRatio(background: number, foregroundHex: string): number {
  const foreground = relativeLuminanceHex(foregroundHex);
  const lighter = Math.max(background, foreground);
  const darker = Math.min(background, foreground);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickHigherContrastText(r: number, g: number, b: number): boolean {
  const background = relativeLuminanceRgb(r, g, b);
  return contrastRatio(background, "#1E1E1E") >= contrastRatio(background, "#E8E3D5");
}

function isLightBackground(): boolean {
  const explicit = process.env.OPENCLAW_THEME?.toLowerCase();
  if (explicit === "light") {
    return true;
  }
  if (explicit === "dark") {
    return false;
  }

  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg && colorfgbg.length <= 64) {
    const sep = colorfgbg.lastIndexOf(";");
    const bg = Number.parseInt(sep >= 0 ? colorfgbg.slice(sep + 1) : colorfgbg, 10);
    if (bg >= 0 && bg <= 255) {
      if (bg <= 15) {
        return bg === 7 || bg === 15;
      }
      if (bg >= 232) {
        return bg >= 244;
      }
      const cubeIndex = bg - 16;
      const bVal = XTERM_LEVELS[cubeIndex % 6];
      const gVal = XTERM_LEVELS[Math.floor(cubeIndex / 6) % 6];
      const rVal = XTERM_LEVELS[Math.floor(cubeIndex / 36)];
      return pickHigherContrastText(rVal, gVal, bVal);
    }
  }
  return false;
}

/** Whether the terminal has a light background. Exported for testing only. */
export const lightMode = isLightBackground();

// Keep upstream's static palette exports for backward compatibility
export const darkPalette = palettes.dark.ui;
export const lightPalette = palettes.light.ui;

export const palette = lightMode ? lightPalette : darkPalette;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

// ---------------------------------------------------------------------------
// Theme builder — creates all themed exports from a palette
// ---------------------------------------------------------------------------

type HighlightTheme = Record<string, (text: string) => string>;

function buildHighlightCode(syntaxTheme: HighlightTheme, codeFallback: string) {
  return function highlightCode(code: string, lang?: string): string[] {
    try {
      const language = lang && supportsLanguage(lang) ? lang : undefined;
      const highlighted = highlight(code, {
        language,
        theme: syntaxTheme,
        ignoreIllegals: true,
      });
      return highlighted.split("\n");
    } catch {
      return code.split("\n").map((line) => fg(codeFallback)(line));
    }
  };
}

function buildTheme(p: Palette) {
  return {
    fg: fg(p.text),
    assistantText: (text: string) => text,
    dim: fg(p.dim),
    accent: fg(p.accent),
    accentSoft: fg(p.accentSoft),
    success: fg(p.success),
    error: fg(p.error),
    header: (text: string) => chalk.bold(fg(p.accent)(text)),
    system: fg(p.systemText),
    userBg: bg(p.userBg),
    userText: fg(p.userText),
    toolTitle: fg(p.toolTitle),
    toolOutput: fg(p.toolOutput),
    toolPendingBg: bg(p.toolPendingBg),
    toolSuccessBg: bg(p.toolSuccessBg),
    toolErrorBg: bg(p.toolErrorBg),
    border: fg(p.border),
    bold: (text: string) => chalk.bold(text),
    italic: (text: string) => chalk.italic(text),
  };
}

function buildMarkdownTheme(p: Palette, syntaxTheme: HighlightTheme): MarkdownTheme {
  return {
    heading: (text) => chalk.bold(fg(p.accent)(text)),
    link: (text) => fg(p.link)(text),
    linkUrl: (text) => chalk.dim(text),
    code: (text) => fg(p.code)(text),
    codeBlock: (text) => fg(p.code)(text),
    codeBlockBorder: (text) => fg(p.codeBorder)(text),
    quote: (text) => fg(p.quote)(text),
    quoteBorder: (text) => fg(p.quoteBorder)(text),
    hr: (text) => fg(p.border)(text),
    listBullet: (text) => fg(p.accentSoft)(text),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: buildHighlightCode(syntaxTheme, p.code),
  };
}

function buildSelectListTheme(p: Palette): SelectListTheme {
  return {
    selectedPrefix: (text) => fg(p.accent)(text),
    selectedText: (text) => chalk.bold(fg(p.accent)(text)),
    description: (text) => fg(p.dim)(text),
    scrollInfo: (text) => fg(p.dim)(text),
    noMatch: (text) => fg(p.dim)(text),
  };
}

function buildSettingsListTheme(p: Palette): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? chalk.bold(fg(p.accent)(text)) : fg(p.text)(text)),
    value: (text, selected) => (selected ? fg(p.accentSoft)(text) : fg(p.dim)(text)),
    description: (text) => fg(p.systemText)(text),
    cursor: fg(p.accent)("→ "),
    hint: (text) => fg(p.dim)(text),
  };
}

function buildSearchableSelectListTheme(p: Palette): SearchableSelectListTheme {
  return {
    selectedPrefix: (text) => fg(p.accent)(text),
    selectedText: (text) => chalk.bold(fg(p.accent)(text)),
    description: (text) => fg(p.dim)(text),
    scrollInfo: (text) => fg(p.dim)(text),
    noMatch: (text) => fg(p.dim)(text),
    searchPrompt: (text) => fg(p.accentSoft)(text),
    searchInput: (text) => fg(p.text)(text),
    matchHighlight: (text) => chalk.bold(fg(p.accent)(text)),
  };
}

// ---------------------------------------------------------------------------
// Exported mutable state — declared first, then initialized.
//
// ESM named imports are live bindings, so consumers always see the
// latest value after setTheme() reassigns them.
// ---------------------------------------------------------------------------

export let theme: ReturnType<typeof buildTheme>;
export let markdownTheme: MarkdownTheme;
export let selectListTheme: SelectListTheme;
export let filterableSelectListTheme: SelectListTheme & { filterLabel: (text: string) => string };
export let settingsListTheme: SettingsListTheme;
export let editorTheme: EditorTheme;
export let searchableSelectListTheme: SearchableSelectListTheme;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let activeThemeName = "";

function applyPalette(tp: ThemePalette) {
  const p = tp.ui;
  const syntaxTheme = createSyntaxThemeFromPalette(tp.syntax, fg(p.code));

  theme = buildTheme(p);
  markdownTheme = buildMarkdownTheme(p, syntaxTheme);
  selectListTheme = buildSelectListTheme(p);
  filterableSelectListTheme = {
    ...selectListTheme,
    filterLabel: (text: string) => fg(p.dim)(text),
  };
  settingsListTheme = buildSettingsListTheme(p);
  editorTheme = {
    borderColor: (text) => fg(p.border)(text),
    selectList: selectListTheme,
  };
  searchableSelectListTheme = buildSearchableSelectListTheme(p);
}

function resolveAndApply(name: string): string {
  const tp = getPalette(name);
  if (!tp) {
    applyPalette(palettes.dark);
    activeThemeName = "dark";
  } else {
    applyPalette(tp);
    activeThemeName = name;
  }
  return activeThemeName;
}

// Initialize with detected theme on module load.
resolveAndApply(detectThemeName());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Switch the active TUI theme at runtime. Returns the resolved theme name. */
export function setTheme(name: string): string {
  return resolveAndApply(name);
}

/** Get the currently active theme name. */
export function getThemeName(): string {
  return activeThemeName;
}
