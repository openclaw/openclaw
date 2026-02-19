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

const DARK_TEXT = "#E8E3D5";
const LIGHT_TEXT = "#1E1E1E";
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
  return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT);
}

function detectTerminalBackground(): "light" | "dark" {
  const explicit = process.env.OPENCLAW_THEME?.toLowerCase();
  if (explicit === "light") {
    return "light";
  }
  if (explicit === "dark") {
    return "dark";
  }

  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg && colorfgbg.length <= 64) {
    const sep = colorfgbg.lastIndexOf(";");
    const bg = Number.parseInt(sep >= 0 ? colorfgbg.slice(sep + 1) : colorfgbg, 10);
    if (bg >= 0 && bg <= 255) {
      if (bg <= 15) {
        return bg === 7 || bg === 15 ? "light" : "dark";
      }
      if (bg >= 232) {
        return bg >= 244 ? "light" : "dark";
      }
      const cubeIndex = bg - 16;
      const bVal = XTERM_LEVELS[cubeIndex % 6];
      const gVal = XTERM_LEVELS[Math.floor(cubeIndex / 6) % 6];
      const rVal = XTERM_LEVELS[Math.floor(cubeIndex / 36)];
      return pickHigherContrastText(rVal, gVal, bVal) ? "light" : "dark";
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

let currentMode: "dark" | "light" = detectTerminalBackground();

/** Whether the terminal has a light background. Exported for testing only. */
export const lightMode = currentMode === "light";

/**
 * Set the active theme mode. Call before TUI renders.
 */
export function setThemeMode(mode: ThemeMode): void {
  currentMode = resolveThemeMode(mode);
}

export const darkPalette = {
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
} as const;

export const lightPalette = {
  text: "#1E1E1E",
  dim: "#5B6472",
  accent: "#B45309",
  accentSoft: "#C2410C",
  border: "#5B6472",
  userBg: "#F3F0E8",
  userText: "#1E1E1E",
  systemText: "#4B5563",
  toolPendingBg: "#EFF6FF",
  toolSuccessBg: "#ECFDF5",
  toolErrorBg: "#FEF2F2",
  toolTitle: "#B45309",
  toolOutput: "#374151",
  quote: "#1D4ED8",
  quoteBorder: "#2563EB",
  code: "#92400E",
  codeBlock: "#F9FAFB",
  codeBorder: "#92400E",
  link: "#047857",
  error: "#DC2626",
  success: "#047857",
} as const;

/**
 * Get the current palette based on active theme.
 */
function getPalette() {
  return currentMode === "light" ? lightPalette : darkPalette;
}

/** Static alias kept for backwards compatibility with direct importers. */
export const palette = getPalette();

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

/**
 * Highlight code with syntax coloring.
 * Returns an array of lines with ANSI escape codes.
 */
function highlightCode(code: string, lang?: string): string[] {
  const p = getPalette();
  const isLight = currentMode === "light";
  const syntaxTheme = createSyntaxTheme(fg(p.code), isLight);
  try {
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    return highlighted.split("\n");
  } catch {
    return code.split("\n").map((line) => fg(p.code)(line));
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

const baseSelectListTheme: SelectListTheme = {
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

export const selectListTheme: SelectListTheme = baseSelectListTheme;

export const filterableSelectListTheme = {
  ...baseSelectListTheme,
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
  ...baseSelectListTheme,
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
