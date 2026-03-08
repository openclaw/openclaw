import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";
import { createSyntaxTheme } from "./syntax-theme.js";

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

let currentMode: "dark" | "light" = "dark";

/**
 * Detect terminal background from environment hints.
 */
function detectTerminalBackground(): "light" | "dark" {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const bgColor = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bgColor)) {
      return bgColor < 8 ? "dark" : "light";
    }
  }
  return "dark";
}

/**
 * Resolve theme mode, handling "auto" detection.
 */
export function resolveThemeMode(mode: ThemeMode): "dark" | "light" {
  if (mode === "auto") {
    return detectTerminalBackground();
  }
  return mode;
}

/**
 * Set the active theme mode.
 */
export function setThemeMode(mode: ThemeMode): void {
  currentMode = resolveThemeMode(mode);
}

/**
 * Get the current palette based on active theme.
 */
function getPalette() {
  return currentMode === "light" ? lightPalette : darkPalette;
}

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

/**
 * Highlight code with syntax coloring.
 */
function highlightCode(code: string, lang?: string): string[] {
  const palette = getPalette();
  const syntaxTheme = createSyntaxTheme(fg(palette.code));
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    return highlighted.split("\n");
  } catch {
    return code.split("\n").map((line) => fg(palette.code)(line));
  }
}

export const theme = {
  get fg() {
    return fg(getPalette().text);
  },
  assistantText: (text: string) => text,
  get dim() {
    return fg(getPalette().dim);
  },
  get accent() {
    return fg(getPalette().accent);
  },
  get accentSoft() {
    return fg(getPalette().accentSoft);
  },
  get success() {
    return fg(getPalette().success);
  },
  get error() {
    return fg(getPalette().error);
  },
  get header() {
    const p = getPalette();
    return (text: string) => chalk.bold(fg(p.accent)(text));
  },
  get system() {
    return fg(getPalette().systemText);
  },
  get userBg() {
    return bg(getPalette().userBg);
  },
  get userText() {
    return fg(getPalette().userText);
  },
  get toolTitle() {
    return fg(getPalette().toolTitle);
  },
  get toolOutput() {
    return fg(getPalette().toolOutput);
  },
  get toolPendingBg() {
    return bg(getPalette().toolPendingBg);
  },
  get toolSuccessBg() {
    return bg(getPalette().toolSuccessBg);
  },
  get toolErrorBg() {
    return bg(getPalette().toolErrorBg);
  },
  get border() {
    return fg(getPalette().border);
  },
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
};

export const markdownTheme: MarkdownTheme = {
  get heading() {
    const p = getPalette();
    return (text: string) => chalk.bold(fg(p.accent)(text));
  },
  get link() {
    return (text: string) => fg(getPalette().link)(text);
  },
  linkUrl: (text: string) => chalk.dim(text),
  get code() {
    return (text: string) => fg(getPalette().code)(text);
  },
  get codeBlock() {
    return (text: string) => fg(getPalette().code)(text);
  },
  get codeBlockBorder() {
    return (text: string) => fg(getPalette().codeBorder)(text);
  },
  get quote() {
    return (text: string) => fg(getPalette().quote)(text);
  },
  get quoteBorder() {
    return (text: string) => fg(getPalette().quoteBorder)(text);
  },
  get hr() {
    return (text: string) => fg(getPalette().border)(text);
  },
  get listBullet() {
    return (text: string) => fg(getPalette().accentSoft)(text);
  },
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
  highlightCode,
};

export const selectListTheme: SelectListTheme = {
  get selectedPrefix() {
    return (text: string) => fg(getPalette().accent)(text);
  },
  get selectedText() {
    const p = getPalette();
    return (text: string) => chalk.bold(fg(p.accent)(text));
  },
  get description() {
    return (text: string) => fg(getPalette().dim)(text);
  },
  get scrollInfo() {
    return (text: string) => fg(getPalette().dim)(text);
  },
  get noMatch() {
    return (text: string) => fg(getPalette().dim)(text);
  },
};

export const filterableSelectListTheme = {
  ...selectListTheme,
  get filterLabel() {
    return (text: string) => fg(getPalette().dim)(text);
  },
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
  get description() {
    return (text: string) => fg(getPalette().systemText)(text);
  },
  get cursor() {
    return fg(getPalette().accent)("→ ");
  },
  get hint() {
    return (text: string) => fg(getPalette().dim)(text);
  },
};

export const editorTheme: EditorTheme = {
  get borderColor() {
    return (text: string) => fg(getPalette().border)(text);
  },
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  get selectedPrefix() {
    return (text: string) => fg(getPalette().accent)(text);
  },
  get selectedText() {
    const p = getPalette();
    return (text: string) => chalk.bold(fg(p.accent)(text));
  },
  get description() {
    return (text: string) => fg(getPalette().dim)(text);
  },
  get scrollInfo() {
    return (text: string) => fg(getPalette().dim)(text);
  },
  get noMatch() {
    return (text: string) => fg(getPalette().dim)(text);
  },
  get searchPrompt() {
    return (text: string) => fg(getPalette().accentSoft)(text);
  },
  get searchInput() {
    return (text: string) => fg(getPalette().text)(text);
  },
  get matchHighlight() {
    const p = getPalette();
    return (text: string) => chalk.bold(fg(p.accent)(text));
  },
};
