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
import { getActivePalette, onPaletteChange, type TuiThemePalette } from "./theme-registry.js";

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);
const bg = (hex: string) => (text: string) => chalk.bgHex(hex)(text);

// ── Build Theme Functions From Palette ───────────────────────────────

function buildHighlightCode(palette: TuiThemePalette) {
  const syntaxTheme = createSyntaxTheme(fg(palette.code));
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
      return code.split("\n").map((line) => fg(palette.code)(line));
    }
  };
}

function rebuildTheme(palette: TuiThemePalette) {
  theme.fg = fg(palette.text);
  theme.assistantText = (text: string) => text;
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
  theme.bold = (text: string) => chalk.bold(text);
  theme.italic = (text: string) => chalk.italic(text);
}

function rebuildMarkdownTheme(palette: TuiThemePalette) {
  markdownTheme.heading = (text) => chalk.bold(fg(palette.accent)(text));
  markdownTheme.link = (text) => fg(palette.link)(text);
  markdownTheme.linkUrl = (text) => chalk.dim(text);
  markdownTheme.code = (text) => fg(palette.code)(text);
  markdownTheme.codeBlock = (text) => fg(palette.code)(text);
  markdownTheme.codeBlockBorder = (text) => fg(palette.codeBorder)(text);
  markdownTheme.quote = (text) => fg(palette.quote)(text);
  markdownTheme.quoteBorder = (text) => fg(palette.quoteBorder)(text);
  markdownTheme.hr = (text) => fg(palette.border)(text);
  markdownTheme.listBullet = (text) => fg(palette.accentSoft)(text);
  markdownTheme.bold = (text) => chalk.bold(text);
  markdownTheme.italic = (text) => chalk.italic(text);
  markdownTheme.strikethrough = (text) => chalk.strikethrough(text);
  markdownTheme.underline = (text) => chalk.underline(text);
  markdownTheme.highlightCode = buildHighlightCode(palette);
}

function rebuildSelectListTheme(palette: TuiThemePalette) {
  selectListTheme.selectedPrefix = (text) => fg(palette.accent)(text);
  selectListTheme.selectedText = (text) => chalk.bold(fg(palette.accent)(text));
  selectListTheme.description = (text) => fg(palette.dim)(text);
  selectListTheme.scrollInfo = (text) => fg(palette.dim)(text);
  selectListTheme.noMatch = (text) => fg(palette.dim)(text);
}

function rebuildFilterableSelectListTheme(palette: TuiThemePalette) {
  filterableSelectListTheme.selectedPrefix = selectListTheme.selectedPrefix;
  filterableSelectListTheme.selectedText = selectListTheme.selectedText;
  filterableSelectListTheme.description = selectListTheme.description;
  filterableSelectListTheme.scrollInfo = selectListTheme.scrollInfo;
  filterableSelectListTheme.noMatch = selectListTheme.noMatch;
  filterableSelectListTheme.filterLabel = (text: string) => fg(palette.dim)(text);
}

function rebuildSettingsListTheme(palette: TuiThemePalette) {
  settingsListTheme.label = (text, selected) =>
    selected ? chalk.bold(fg(palette.accent)(text)) : fg(palette.text)(text);
  settingsListTheme.value = (text, selected) =>
    selected ? fg(palette.accentSoft)(text) : fg(palette.dim)(text);
  settingsListTheme.description = (text) => fg(palette.systemText)(text);
  settingsListTheme.cursor = fg(palette.accent)("→ ");
  settingsListTheme.hint = (text) => fg(palette.dim)(text);
}

function rebuildEditorTheme() {
  editorTheme.borderColor = theme.border;
  editorTheme.selectList = selectListTheme;
}

function rebuildSearchableSelectListTheme(palette: TuiThemePalette) {
  searchableSelectListTheme.selectedPrefix = (text) => fg(palette.accent)(text);
  searchableSelectListTheme.selectedText = (text) => chalk.bold(fg(palette.accent)(text));
  searchableSelectListTheme.description = (text) => fg(palette.dim)(text);
  searchableSelectListTheme.scrollInfo = (text) => fg(palette.dim)(text);
  searchableSelectListTheme.noMatch = (text) => fg(palette.dim)(text);
  searchableSelectListTheme.searchPrompt = (text) => fg(palette.accentSoft)(text);
  searchableSelectListTheme.searchInput = (text) => fg(palette.text)(text);
  searchableSelectListTheme.matchHighlight = (text) => chalk.bold(fg(palette.accent)(text));
}

// ── Initial Build ────────────────────────────────────────────────────

const initialPalette = getActivePalette();

// Mutable theme objects - rebuilt in-place on palette change.
// Components import these and call theme.X(text) each render,
// so they automatically pick up new colors after a theme switch.

/** Theme object type with known keys plus arbitrary extras. */
export type TuiTheme = Record<string, (text: string) => string> & {
  dim: (text: string) => string;
  bold: (text: string) => string;
  accent: (text: string) => string;
  accentSoft: (text: string) => string;
};

export const theme: TuiTheme = {
  fg: fg(initialPalette.text),
  assistantText: (text: string) => text,
  dim: fg(initialPalette.dim),
  accent: fg(initialPalette.accent),
  accentSoft: fg(initialPalette.accentSoft),
  success: fg(initialPalette.success),
  error: fg(initialPalette.error),
  header: (text: string) => chalk.bold(fg(initialPalette.accent)(text)),
  system: fg(initialPalette.systemText),
  userBg: bg(initialPalette.userBg),
  userText: fg(initialPalette.userText),
  toolTitle: fg(initialPalette.toolTitle),
  toolOutput: fg(initialPalette.toolOutput),
  toolPendingBg: bg(initialPalette.toolPendingBg),
  toolSuccessBg: bg(initialPalette.toolSuccessBg),
  toolErrorBg: bg(initialPalette.toolErrorBg),
  border: fg(initialPalette.border),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold(fg(initialPalette.accent)(text)),
  link: (text) => fg(initialPalette.link)(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => fg(initialPalette.code)(text),
  codeBlock: (text) => fg(initialPalette.code)(text),
  codeBlockBorder: (text) => fg(initialPalette.codeBorder)(text),
  quote: (text) => fg(initialPalette.quote)(text),
  quoteBorder: (text) => fg(initialPalette.quoteBorder)(text),
  hr: (text) => fg(initialPalette.border)(text),
  listBullet: (text) => fg(initialPalette.accentSoft)(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode: buildHighlightCode(initialPalette),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => fg(initialPalette.accent)(text),
  selectedText: (text) => chalk.bold(fg(initialPalette.accent)(text)),
  description: (text) => fg(initialPalette.dim)(text),
  scrollInfo: (text) => fg(initialPalette.dim)(text),
  noMatch: (text) => fg(initialPalette.dim)(text),
};

export const filterableSelectListTheme = {
  ...selectListTheme,
  filterLabel: (text: string) => fg(initialPalette.dim)(text),
};

export const settingsListTheme: SettingsListTheme = {
  label: (text, selected) =>
    selected ? chalk.bold(fg(initialPalette.accent)(text)) : fg(initialPalette.text)(text),
  value: (text, selected) =>
    selected ? fg(initialPalette.accentSoft)(text) : fg(initialPalette.dim)(text),
  description: (text) => fg(initialPalette.systemText)(text),
  cursor: fg(initialPalette.accent)("→ "),
  hint: (text) => fg(initialPalette.dim)(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg(initialPalette.border)(text),
  selectList: selectListTheme,
};

export const searchableSelectListTheme: SearchableSelectListTheme = {
  selectedPrefix: (text) => fg(initialPalette.accent)(text),
  selectedText: (text) => chalk.bold(fg(initialPalette.accent)(text)),
  description: (text) => fg(initialPalette.dim)(text),
  scrollInfo: (text) => fg(initialPalette.dim)(text),
  noMatch: (text) => fg(initialPalette.dim)(text),
  searchPrompt: (text) => fg(initialPalette.accentSoft)(text),
  searchInput: (text) => fg(initialPalette.text)(text),
  matchHighlight: (text) => chalk.bold(fg(initialPalette.accent)(text)),
};

// ── Subscribe to Palette Changes ─────────────────────────────────────

onPaletteChange((palette) => {
  rebuildTheme(palette);
  rebuildMarkdownTheme(palette);
  rebuildSelectListTheme(palette);
  rebuildFilterableSelectListTheme(palette);
  rebuildSettingsListTheme(palette);
  rebuildEditorTheme();
  rebuildSearchableSelectListTheme(palette);
});
