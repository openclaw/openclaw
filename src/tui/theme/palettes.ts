/**
 * Color palette definitions for TUI themes.
 *
 * Each palette provides a complete set of semantic colors used by the TUI.
 * All hex values must include the '#' prefix.
 */

export type Palette = {
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
};

export type SyntaxPalette = {
  keyword: string;
  builtIn: string;
  type: string;
  literal: string;
  number: string;
  string: string;
  regexp: string;
  symbol: string;
  class: string;
  function: string;
  title: string;
  params: string;
  comment: string;
  doctag: string;
  meta: string;
  metaKeyword: string;
  metaString: string;
  section: string;
  tag: string;
  name: string;
  attr: string;
  variable: string;
  bullet: string;
  code: string;
  formula: string;
  link: string;
  quote: string;
  addition: string;
  deletion: string;
  selectorTag: string;
  templateTag: string;
  templateVariable: string;
};

export type ThemePalette = {
  ui: Palette;
  syntax: SyntaxPalette;
};

// ---------------------------------------------------------------------------
// Dark (original OpenClaw palette, refined)
// ---------------------------------------------------------------------------

const darkUi: Palette = {
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

const darkSyntax: SyntaxPalette = {
  keyword: "#C586C0",
  builtIn: "#4EC9B0",
  type: "#4EC9B0",
  literal: "#569CD6",
  number: "#B5CEA8",
  string: "#CE9178",
  regexp: "#D16969",
  symbol: "#B5CEA8",
  class: "#4EC9B0",
  function: "#DCDCAA",
  title: "#DCDCAA",
  params: "#9CDCFE",
  comment: "#6A9955",
  doctag: "#608B4E",
  meta: "#9CDCFE",
  metaKeyword: "#C586C0",
  metaString: "#CE9178",
  section: "#DCDCAA",
  tag: "#569CD6",
  name: "#9CDCFE",
  attr: "#9CDCFE",
  variable: "#9CDCFE",
  bullet: "#D7BA7D",
  code: "#CE9178",
  formula: "#C586C0",
  link: "#4EC9B0",
  quote: "#6A9955",
  addition: "#B5CEA8",
  deletion: "#F44747",
  selectorTag: "#D7BA7D",
  templateTag: "#C586C0",
  templateVariable: "#9CDCFE",
};

// ---------------------------------------------------------------------------
// Light — WCAG AA compliant on white/light backgrounds
// ---------------------------------------------------------------------------

const lightUi: Palette = {
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
};

const lightSyntax: SyntaxPalette = {
  keyword: "#7C3AED",
  builtIn: "#0D9488",
  type: "#0D9488",
  literal: "#1D4ED8",
  number: "#15803D",
  string: "#B45309",
  regexp: "#DC2626",
  symbol: "#15803D",
  class: "#0D9488",
  function: "#854D0E",
  title: "#854D0E",
  params: "#1E40AF",
  comment: "#6B7280",
  doctag: "#4B5563",
  meta: "#1E40AF",
  metaKeyword: "#7C3AED",
  metaString: "#B45309",
  section: "#854D0E",
  tag: "#1D4ED8",
  name: "#1E40AF",
  attr: "#1E40AF",
  variable: "#1E40AF",
  bullet: "#92400E",
  code: "#B45309",
  formula: "#7C3AED",
  link: "#0D9488",
  quote: "#6B7280",
  addition: "#15803D",
  deletion: "#DC2626",
  selectorTag: "#92400E",
  templateTag: "#7C3AED",
  templateVariable: "#1E40AF",
};

// ---------------------------------------------------------------------------
// Dracula
// ---------------------------------------------------------------------------

const draculaUi: Palette = {
  text: "#F8F8F2",
  dim: "#6272A4",
  accent: "#BD93F9",
  accentSoft: "#FF79C6",
  border: "#44475A",
  userBg: "#2D3250",
  userText: "#F8F8F2",
  systemText: "#6272A4",
  toolPendingBg: "#21222C",
  toolSuccessBg: "#1A2E1A",
  toolErrorBg: "#3B1C1C",
  toolTitle: "#BD93F9",
  toolOutput: "#F8F8F2",
  quote: "#8BE9FD",
  quoteBorder: "#44475A",
  code: "#FFB86C",
  codeBlock: "#21222C",
  codeBorder: "#44475A",
  link: "#8BE9FD",
  error: "#FF5555",
  success: "#50FA7B",
};

const draculaSyntax: SyntaxPalette = {
  keyword: "#FF79C6",
  builtIn: "#8BE9FD",
  type: "#8BE9FD",
  literal: "#BD93F9",
  number: "#BD93F9",
  string: "#F1FA8C",
  regexp: "#FF5555",
  symbol: "#BD93F9",
  class: "#8BE9FD",
  function: "#50FA7B",
  title: "#50FA7B",
  params: "#FFB86C",
  comment: "#6272A4",
  doctag: "#6272A4",
  meta: "#FFB86C",
  metaKeyword: "#FF79C6",
  metaString: "#F1FA8C",
  section: "#50FA7B",
  tag: "#FF79C6",
  name: "#8BE9FD",
  attr: "#50FA7B",
  variable: "#FFB86C",
  bullet: "#BD93F9",
  code: "#FFB86C",
  formula: "#FF79C6",
  link: "#8BE9FD",
  quote: "#6272A4",
  addition: "#50FA7B",
  deletion: "#FF5555",
  selectorTag: "#BD93F9",
  templateTag: "#FF79C6",
  templateVariable: "#FFB86C",
};

// ---------------------------------------------------------------------------
// Catppuccin Mocha
// ---------------------------------------------------------------------------

const catppuccinMochaUi: Palette = {
  text: "#CDD6F4",
  dim: "#6C7086",
  accent: "#F9E2AF",
  accentSoft: "#FAB387",
  border: "#45475A",
  userBg: "#2A2B3D",
  userText: "#CDD6F4",
  systemText: "#A6ADC8",
  toolPendingBg: "#1E1E2E",
  toolSuccessBg: "#1A2E1F",
  toolErrorBg: "#302030",
  toolTitle: "#F9E2AF",
  toolOutput: "#BAC2DE",
  quote: "#89B4FA",
  quoteBorder: "#45475A",
  code: "#FAB387",
  codeBlock: "#1E1E2E",
  codeBorder: "#45475A",
  link: "#94E2D5",
  error: "#F38BA8",
  success: "#A6E3A1",
};

const catppuccinMochaSyntax: SyntaxPalette = {
  keyword: "#CBA6F7",
  builtIn: "#94E2D5",
  type: "#89DCEB",
  literal: "#89B4FA",
  number: "#FAB387",
  string: "#A6E3A1",
  regexp: "#F38BA8",
  symbol: "#F2CDCD",
  class: "#89DCEB",
  function: "#89B4FA",
  title: "#89B4FA",
  params: "#EBA0AC",
  comment: "#6C7086",
  doctag: "#585B70",
  meta: "#F5C2E7",
  metaKeyword: "#CBA6F7",
  metaString: "#A6E3A1",
  section: "#89B4FA",
  tag: "#CBA6F7",
  name: "#89B4FA",
  attr: "#F9E2AF",
  variable: "#EBA0AC",
  bullet: "#FAB387",
  code: "#FAB387",
  formula: "#CBA6F7",
  link: "#94E2D5",
  quote: "#6C7086",
  addition: "#A6E3A1",
  deletion: "#F38BA8",
  selectorTag: "#CBA6F7",
  templateTag: "#CBA6F7",
  templateVariable: "#EBA0AC",
};

// ---------------------------------------------------------------------------
// Solarized Dark
// ---------------------------------------------------------------------------

const solarizedDarkUi: Palette = {
  text: "#839496",
  dim: "#586E75",
  accent: "#B58900",
  accentSoft: "#CB4B16",
  border: "#073642",
  userBg: "#073642",
  userText: "#EEE8D5",
  systemText: "#657B83",
  toolPendingBg: "#002B36",
  toolSuccessBg: "#003B2A",
  toolErrorBg: "#2B1A1A",
  toolTitle: "#B58900",
  toolOutput: "#93A1A1",
  quote: "#268BD2",
  quoteBorder: "#073642",
  code: "#CB4B16",
  codeBlock: "#002B36",
  codeBorder: "#073642",
  link: "#2AA198",
  error: "#DC322F",
  success: "#859900",
};

const solarizedDarkSyntax: SyntaxPalette = {
  keyword: "#859900",
  builtIn: "#2AA198",
  type: "#B58900",
  literal: "#268BD2",
  number: "#D33682",
  string: "#2AA198",
  regexp: "#DC322F",
  symbol: "#CB4B16",
  class: "#B58900",
  function: "#268BD2",
  title: "#268BD2",
  params: "#93A1A1",
  comment: "#586E75",
  doctag: "#586E75",
  meta: "#CB4B16",
  metaKeyword: "#859900",
  metaString: "#2AA198",
  section: "#268BD2",
  tag: "#268BD2",
  name: "#268BD2",
  attr: "#93A1A1",
  variable: "#CB4B16",
  bullet: "#859900",
  code: "#CB4B16",
  formula: "#D33682",
  link: "#2AA198",
  quote: "#586E75",
  addition: "#859900",
  deletion: "#DC322F",
  selectorTag: "#859900",
  templateTag: "#859900",
  templateVariable: "#CB4B16",
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const palettes: Record<string, ThemePalette> = {
  dark: { ui: darkUi, syntax: darkSyntax },
  light: { ui: lightUi, syntax: lightSyntax },
  dracula: { ui: draculaUi, syntax: draculaSyntax },
  "catppuccin-mocha": { ui: catppuccinMochaUi, syntax: catppuccinMochaSyntax },
  "solarized-dark": { ui: solarizedDarkUi, syntax: solarizedDarkSyntax },
};

export const paletteNames = Object.keys(palettes);

export function getPalette(name: string): ThemePalette | undefined {
  return palettes[name];
}
