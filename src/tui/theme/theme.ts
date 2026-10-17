import fs from "node:fs";
import path from "node:path";
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@earendil-works/pi-tui";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import chalk from "chalk";
import { resolveConfigPath } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
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

const DARK_PALETTE = {
  text: DARK_TEXT,
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
  codeBorder: "#343A45",
  link: "#7DD3A5",
  error: "#F97066",
  success: "#7DD3A5",
};

type Palette = typeof DARK_PALETTE;

const LIGHT_PALETTE: Palette = {
  text: LIGHT_TEXT,
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
  codeBorder: "#92400E",
  link: "#047857",
  error: "#DC2626",
  success: "#047857",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const THEME_NAME = /^[\w.-]+$/;
const THEME_KEYS = new Set(["$schema", "name", "base", "colors"]);
const MAX_LISTED_KEYS = 5;

function listKeys(keys: string[]): string {
  const listed = keys.slice(0, MAX_LISTED_KEYS).join(", ");
  const more = keys.length - MAX_LISTED_KEYS;
  return more > 0 ? `${listed} and ${more} more` : listed;
}

function isPaletteKey(key: string): key is keyof Palette {
  return Object.hasOwn(DARK_PALETTE, key);
}

// A bad theme file must never block TUI startup.
function loadNamedTheme(name: string, detected: Palette): { palette: Palette; warnings: string[] } {
  const label = `theme "${name}"`;
  const fallback = (reason: string) => ({
    palette: detected,
    warnings: [`${label}: ${reason}; using the built-in palette`],
  });
  if (!THEME_NAME.test(name)) {
    return fallback("names may only contain letters, digits, '.', '_' and '-'");
  }
  const file = path.join(path.dirname(resolveConfigPath()), "themes", `${name}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return fallback(
      isRecord(err) && err.code === "ENOENT"
        ? `${file} not found`
        : `cannot load ${file}: ${formatErrorMessage(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    return fallback(`${file} must contain a JSON object`);
  }

  const warnings: string[] = [];
  const unknownKeys = Object.keys(parsed).filter((key) => !THEME_KEYS.has(key));
  if (unknownKeys.length > 0) {
    warnings.push(`${label}: unknown keys ignored: ${listKeys(unknownKeys)}`);
  }
  let palette = detected;
  if (parsed.base === "dark" || parsed.base === "light") {
    palette = parsed.base === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  } else if (parsed.base !== undefined) {
    warnings.push(`${label}: base must be "dark" or "light"`);
  }
  palette = { ...palette };
  const colors = parsed.colors ?? {};
  if (!isRecord(colors)) {
    warnings.push(`${label}: colors must be an object`);
    return { palette, warnings };
  }
  // One notice per kind of problem: each notice is re-shown whenever history reloads.
  const unknownColors: string[] = [];
  const invalidColors: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    if (!isPaletteKey(key)) {
      unknownColors.push(key);
    } else if (typeof value !== "string" || !HEX_COLOR.test(value)) {
      invalidColors.push(key);
    } else {
      palette[key] = value;
    }
  }
  if (unknownColors.length > 0) {
    warnings.push(`${label}: unknown colors ignored: ${listKeys(unknownColors)}`);
  }
  if (invalidColors.length > 0) {
    warnings.push(`${label}: colors must be #RRGGBB hex strings: ${listKeys(invalidColors)}`);
  }
  return { palette, warnings };
}

function resolvePalette(): { palette: Palette; warnings: string[] } {
  const detected = isLightBackground() ? LIGHT_PALETTE : DARK_PALETTE;
  const name = process.env.OPENCLAW_THEME?.trim();
  const builtIn = normalizeOptionalLowercaseString(name);
  if (!name || builtIn === "light" || builtIn === "dark") {
    return { palette: detected, warnings: [] };
  }
  return loadNamedTheme(name, detected);
}

const resolved = resolvePalette();
const palette = resolved.palette;

export const themeWarnings: readonly string[] = resolved.warnings;

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
