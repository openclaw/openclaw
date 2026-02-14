import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";
import { createSyntaxTheme, createLightSyntaxTheme } from "./syntax-theme.js";

export type ThemeMode = "dark" | "light" | "auto";

const darkPalette = {
  text: "#E8E3D5",
  dim: "#7B7F87",
  accent: "#F6C453",
  accentSoft: "#F2A65A",
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

const lightPalette = {
  text: "#1E1E1E",
  dim: "#6B7280",
  accent: "#B8860B",
  accentSoft: "#C47F17",
  border: "#D1D5DB",
  userBg: "#E8E3D5",
  userText: "#1E1E1E",
  systemText: "#4B5563",
  toolPendingBg: "#EFF6FF",
  toolSuccessBg: "#ECFDF5",
  toolErrorBg: "#FEF2F2",
  toolTitle: "#92400E",
  toolOutput: "#374151",
  quote: "#1D4ED8",
  quoteBorder: "#93C5FD",
  code: "#92400E",
  codeBlock: "#F3F4F6",
  codeBorder: "#D1D5DB",
  link: "#047857",
  error: "#DC2626",
  success: "#047857",
};

/**
 * Detect whether the terminal background is light or dark.
 * Falls back to "dark" when detection is not possible.
 */
function detectTerminalBackground(): "light" | "dark" {
  // COLORFGBG is set by many terminal emulators (e.g., xterm, rxvt, GNOME Terminal).
  // Format: "<fg>;<bg>" where bg >= 8 typically means dark, < 8 means light.
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bgColor = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bgColor)) {
      return bgColor < 8 ? "dark" : "light";
    }
  }

  // Some terminals/apps set explicit theme hints
  const termProgram = process.env.TERM_PROGRAM;

  // macOS Terminal.app defaults to light
  if (termProgram === "Apple_Terminal" && !colorfgbg) {
    return "light";
  }

  // If nothing detected, default to dark (most common for terminal users)
  return "dark";
}

let resolvedMode: "light" | "dark" | undefined;

/**
 * Resolve the effective theme mode. Call once at startup.
 */
export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") {
    resolvedMode = detectTerminalBackground();
  } else {
    resolvedMode = mode;
  }
  return resolvedMode;
}

/**
 * Get the currently resolved theme mode.
 * Defaults to "dark" if resolveThemeMode hasn't been called.
 */
export function getThemeMode(): "light" | "dark" {
  return resolvedMode ?? "dark";
}

function getPalette() {
  return getThemeMode() === "light" ? lightPalette : darkPalette;
}

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

function getSyntaxTheme() {
  const p = getPalette();
  return getThemeMode() === "light"
    ? createLightSyntaxTheme(fg(p.code))
    : createSyntaxTheme(fg(p.code));
}

/**
 * Highlight code with syntax coloring.
 * Returns an array of lines with ANSI escape codes.
 */
function highlightCode(code: string, lang?: string): string[] {
  const p = getPalette();
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: getSyntaxTheme(),
      ignoreIllegals: true,
    });
    return highlighted.split("\n");
  } catch {
    return code.split("\n").map((line) => fg(p.code)(line));
  }
}

export const theme = {
  get fg() { const p = getPalette(); return fg(p.text); },
  assistantText: (text: string) => text,
  get dim() { const p = getPalette(); return fg(p.dim); },
  get accent() { const p = getPalette(); return fg(p.accent); },
  get accentSoft() { const p = getPalette(); return fg(p.accentSoft); },
  get success() { const p = getPalette(); return fg(p.success); },
  get error() { const p = getPalette(); return fg(p.error); },
  get header() { const p = getPalette(); return (text: string) => chalk.bold(fg(p.accent)(text)); },
  get system() { const p = getPalette(); return fg(p.systemText); },
  get userBg() { const p = getPalette(); return bg(p.userBg); },
  get userText() { const p = getPalette(); return fg(p.userText); },
  get toolTitle() { const p = getPalette(); return fg(p.toolTitle); },
  get toolOutput() { const p = getPalette(); return fg(p.toolOutput); },
  get toolPendingBg() { const p = getPalette(); return bg(p.toolPendingBg); },
  get toolSuccessBg() { const p = getPalette(); return bg(p.toolSuccessBg); },
  get toolErrorBg() { const p = getPalette(); return bg(p.toolErrorBg); },
  get border() { const p = getPalette(); return fg(p.border); },
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
};

export const markdownTheme: MarkdownTheme = {
  get heading() { const p = getPalette(); return (text: string) => chalk.bold(fg(p.accent)(text)); },
  get link() { const p = getPalette(); return (text: string) => fg(p.link)(text); },
  linkUrl: (text) => chalk.dim(text),
  get code() { const p = getPalette(); return (text: string) => fg(p.code)(text); },
  get codeBlock() { const p = getPalette(); return (text: string) => fg(p.code)(text); },
  get codeBlockBorder() { const p = getPalette(); return (text: string) => fg(p.codeBorder)(text); },
  get quote() { const p = getPalette(); return (text: string) => fg(p.quote)(text); },
  get quoteBorder() { const p = getPalette(); return (text: string) => fg(p.quoteBorder)(text); },
  get hr() { const p = getPalette(); return (text: string) => fg(p.border)(text); },
  get listBullet() { const p = getPalette(); return (text: string) => fg(p.accentSoft)(text); },
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode,
};

export const selectListTheme: SelectListTheme = {
  get selectedPrefix() { const p = getPalette(); return (text: string) => fg(p.accent)(text); },
  get selectedText() { const p = getPalette(); return (text: string) => chalk.bold(fg(p.accent)(text)); },
  get description() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
  get scrollInfo() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
  get noMatch() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
};

export const filterableSelectListTheme = {
  ...selectListTheme,
  get filterLabel() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
};

export const settingsListTheme: SettingsListTheme = {
  label: (text, selected) => {
    const p = getPalette();
    return selected ? chalk.bold(fg(p.accent)(text)) : fg(p.text)(text);
  },
  value: (text, selected) => {
    const p = getPalette();
    return selected ? fg(p.accentSoft)(text) : fg(p.dim)(text);
  },
  get description() { const p = getPalette(); return (text: string) => fg(p.systemText)(text); },
  get cursor() { const p = getPalette(); return fg(p.accent)("→ "); },
  get hint() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
};

export const editorTheme: EditorTheme = {
  get borderColor() { const p = getPalette(); return (text: string) => fg(p.border)(text); },
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  get selectedPrefix() { const p = getPalette(); return (text: string) => fg(p.accent)(text); },
  get selectedText() { const p = getPalette(); return (text: string) => chalk.bold(fg(p.accent)(text)); },
  get description() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
  get scrollInfo() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
  get noMatch() { const p = getPalette(); return (text: string) => fg(p.dim)(text); },
  get searchPrompt() { const p = getPalette(); return (text: string) => fg(p.accentSoft)(text); },
  get searchInput() { const p = getPalette(); return (text: string) => fg(p.text)(text); },
  get matchHighlight() { const p = getPalette(); return (text: string) => chalk.bold(fg(p.accent)(text)); },
};
