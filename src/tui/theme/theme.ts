import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { SearchableSelectListTheme } from "../components/searchable-select-list.js";

const palette = {
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

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

/**
 * Syntax highlighting theme for code blocks.
 * Uses chalk functions to style different token types.
 */
const syntaxTheme = {
  keyword: chalk.hex("#C586C0"), // purple - if, const, function, etc.
  built_in: chalk.hex("#4EC9B0"), // teal - console, Math, etc.
  type: chalk.hex("#4EC9B0"), // teal - types
  literal: chalk.hex("#569CD6"), // blue - true, false, null
  number: chalk.hex("#B5CEA8"), // green - numbers
  string: chalk.hex("#CE9178"), // orange - strings
  regexp: chalk.hex("#D16969"), // red - regex
  symbol: chalk.hex("#B5CEA8"), // green - symbols
  class: chalk.hex("#4EC9B0"), // teal - class names
  function: chalk.hex("#DCDCAA"), // yellow - function names
  title: chalk.hex("#DCDCAA"), // yellow - titles/names
  params: chalk.hex("#9CDCFE"), // light blue - parameters
  comment: chalk.hex("#6A9955"), // green - comments
  doctag: chalk.hex("#608B4E"), // darker green - jsdoc tags
  meta: chalk.hex("#9CDCFE"), // light blue - meta/preprocessor
  "meta-keyword": chalk.hex("#C586C0"), // purple
  "meta-string": chalk.hex("#CE9178"), // orange
  section: chalk.hex("#DCDCAA"), // yellow - sections
  tag: chalk.hex("#569CD6"), // blue - HTML/XML tags
  name: chalk.hex("#9CDCFE"), // light blue - tag names
  attr: chalk.hex("#9CDCFE"), // light blue - attributes
  attribute: chalk.hex("#9CDCFE"), // light blue - attributes
  variable: chalk.hex("#9CDCFE"), // light blue - variables
  bullet: chalk.hex("#D7BA7D"), // gold - list bullets in markdown
  code: chalk.hex("#CE9178"), // orange - inline code
  emphasis: chalk.italic, // italic
  strong: chalk.bold, // bold
  formula: chalk.hex("#C586C0"), // purple - math
  link: chalk.hex("#4EC9B0"), // teal - links
  quote: chalk.hex("#6A9955"), // green - quotes
  addition: chalk.hex("#B5CEA8"), // green - diff additions
  deletion: chalk.hex("#F44747"), // red - diff deletions
  "selector-tag": chalk.hex("#D7BA7D"), // gold - CSS selectors
  "selector-id": chalk.hex("#D7BA7D"), // gold
  "selector-class": chalk.hex("#D7BA7D"), // gold
  "selector-attr": chalk.hex("#D7BA7D"), // gold
  "selector-pseudo": chalk.hex("#D7BA7D"), // gold
  "template-tag": chalk.hex("#C586C0"), // purple
  "template-variable": chalk.hex("#9CDCFE"), // light blue
  default: fg(palette.code), // fallback to code color
};

/**
 * Highlight code with syntax coloring.
 * Returns an array of lines with ANSI escape codes.
 */
function highlightCode(code: string, lang?: string): string[] {
  try {
    // Auto-detect can be slow for very large blocks; prefer explicit language when available.
    // Check if language is supported, fall back to auto-detect
    const language = lang && supportsLanguage(lang) ? lang : undefined;
    const highlighted = highlight(code, {
      language,
      theme: syntaxTheme,
      ignoreIllegals: true,
    });
    return highlighted.split("\n");
  } catch {
    // If highlighting fails, return plain code
    return code.split("\n").map((line) => fg(palette.code)(line));
  }
}

export const theme = {
  fg: fg(palette.text),
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

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
  description: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
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
  selectedPrefix: (text) => fg(palette.accent)(text),
  selectedText: (text) => chalk.bold(fg(palette.accent)(text)),
  description: (text) => fg(palette.dim)(text),
  scrollInfo: (text) => fg(palette.dim)(text),
  noMatch: (text) => fg(palette.dim)(text),
  searchPrompt: (text) => fg(palette.accentSoft)(text),
  searchInput: (text) => fg(palette.text)(text),
  matchHighlight: (text) => chalk.bold(fg(palette.accent)(text)),
};
