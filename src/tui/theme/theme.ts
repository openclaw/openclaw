import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@earendil-works/pi-tui";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import chalk from "chalk";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";

const DARK_TEXT = "#E8E3D5";
const LIGHT_TEXT = "#1E1E1E";

function xtermCubeLevel(index: number): number {
  return index === 0 ? 0 : 55 + index * 40;
}

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

function contrastRatio(background: number, foregroundHex: string): number {
  const foreground = relativeLuminanceRgb(
    Number.parseInt(foregroundHex.slice(1, 3), 16),
    Number.parseInt(foregroundHex.slice(3, 5), 16),
    Number.parseInt(foregroundHex.slice(5, 7), 16),
  );
  const lighter = Math.max(background, foreground);
  const darker = Math.min(background, foreground);
  return (lighter + 0.05) / (darker + 0.05);
}

function isLightBackground(): boolean {
  const explicit = normalizeOptionalLowercaseString(process.env.OPENCLAW_THEME);
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
      const background = relativeLuminanceRgb(
        xtermCubeLevel(Math.floor(cubeIndex / 36)),
        xtermCubeLevel(Math.floor(cubeIndex / 6) % 6),
        xtermCubeLevel(cubeIndex % 6),
      );
      return contrastRatio(background, LIGHT_TEXT) >= contrastRatio(background, DARK_TEXT);
    }
  }
  return false;
}

const lightMode = isLightBackground();

const color = (dark: string, light: string) => (lightMode ? light : dark);
const palette = {
  text: color("#E8E3D5", "#1E1E1E"),
  dim: color("#7B7F87", "#5B6472"),
  accent: color("#F6C453", "#B45309"),
  accentSoft: color("#F2A65A", "#C2410C"),
  border: color("#3C414B", "#5B6472"),
  userBg: color("#2B2F36", "#F3F0E8"),
  userText: color("#F3EEE0", "#1E1E1E"),
  systemText: color("#9BA3B2", "#4B5563"),
  toolPendingBg: color("#1F2A2F", "#EFF6FF"),
  toolSuccessBg: color("#1E2D23", "#ECFDF5"),
  toolErrorBg: color("#2F1F1F", "#FEF2F2"),
  toolTitle: color("#F6C453", "#B45309"),
  toolOutput: color("#E1DACB", "#374151"),
  quote: color("#8CC8FF", "#1D4ED8"),
  quoteBorder: color("#3B4D6B", "#2563EB"),
  code: color("#F0C987", "#92400E"),
  codeBorder: color("#343A45", "#92400E"),
  link: color("#7DD3A5", "#047857"),
  error: color("#F97066", "#DC2626"),
  success: color("#7DD3A5", "#047857"),
};

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

// Keep code blocks parser-free on the base TUI path.
function highlightCode(code: string): string[] {
  return code.split("\n").map((line) => fg(palette.code)(line));
}

export const tuiTheme = {
  fg: fg(palette.text),
  assistantText: (text: string) => text,
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
  heading: tuiTheme.header,
  link: fg(palette.link),
  linkUrl: (text) => chalk.dim(text),
  code: fg(palette.code),
  codeBlock: fg(palette.code),
  codeBlockBorder: fg(palette.codeBorder),
  quote: fg(palette.quote),
  quoteBorder: fg(palette.quoteBorder),
  hr: tuiTheme.border,
  listBullet: tuiTheme.accentSoft,
  bold: tuiTheme.bold,
  italic: tuiTheme.italic,
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode,
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: tuiTheme.accent,
  selectedText: tuiTheme.header,
  description: tuiTheme.dim,
  scrollInfo: tuiTheme.dim,
  noMatch: tuiTheme.dim,
};

export const filterableSelectListTheme = {
  ...selectListTheme,
  filterLabel: tuiTheme.dim,
};

export const settingsListTheme: SettingsListTheme = {
  label: (text, selected) =>
    selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text),
  value: (text, selected) => (selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text)),
  description: tuiTheme.system,
  cursor: fg(palette.accent)("→ "),
  hint: tuiTheme.dim,
};

export const editorTheme: EditorTheme = {
  borderColor: tuiTheme.border,
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  ...selectListTheme,
  searchPrompt: tuiTheme.accentSoft,
  searchInput: tuiTheme.fg,
  matchHighlight: tuiTheme.header,
};
