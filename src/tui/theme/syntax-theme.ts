import chalk from "chalk";

type HighlightTheme = Record<string, ((text: string) => string) | typeof chalk.italic | typeof chalk.bold>;

/**
 * Syntax highlighting theme for code blocks (dark variant).
 * Uses chalk functions to style different token types.
 */
export function createSyntaxTheme(fallback: (text: string) => string): HighlightTheme {
  return {
    keyword: chalk.hex("#C586C0"),
    built_in: chalk.hex("#4EC9B0"),
    type: chalk.hex("#4EC9B0"),
    literal: chalk.hex("#569CD6"),
    number: chalk.hex("#B5CEA8"),
    string: chalk.hex("#CE9178"),
    regexp: chalk.hex("#D16969"),
    symbol: chalk.hex("#B5CEA8"),
    class: chalk.hex("#4EC9B0"),
    function: chalk.hex("#DCDCAA"),
    title: chalk.hex("#DCDCAA"),
    params: chalk.hex("#9CDCFE"),
    comment: chalk.hex("#6A9955"),
    doctag: chalk.hex("#608B4E"),
    meta: chalk.hex("#9CDCFE"),
    "meta-keyword": chalk.hex("#C586C0"),
    "meta-string": chalk.hex("#CE9178"),
    section: chalk.hex("#DCDCAA"),
    tag: chalk.hex("#569CD6"),
    name: chalk.hex("#9CDCFE"),
    attr: chalk.hex("#9CDCFE"),
    attribute: chalk.hex("#9CDCFE"),
    variable: chalk.hex("#9CDCFE"),
    bullet: chalk.hex("#D7BA7D"),
    code: chalk.hex("#CE9178"),
    emphasis: chalk.italic,
    strong: chalk.bold,
    formula: chalk.hex("#C586C0"),
    link: chalk.hex("#4EC9B0"),
    quote: chalk.hex("#6A9955"),
    addition: chalk.hex("#B5CEA8"),
    deletion: chalk.hex("#F44747"),
    "selector-tag": chalk.hex("#D7BA7D"),
    "selector-id": chalk.hex("#D7BA7D"),
    "selector-class": chalk.hex("#D7BA7D"),
    "selector-attr": chalk.hex("#D7BA7D"),
    "selector-pseudo": chalk.hex("#D7BA7D"),
    "template-tag": chalk.hex("#C586C0"),
    "template-variable": chalk.hex("#9CDCFE"),
    default: fallback,
  };
}

// Light syntax theme colors — dark saturated colors readable on light backgrounds
const LIGHT_SYNTAX: Record<string, string> = {
  keyword: "#7B30A0",
  built_in: "#1A7A6A",
  type: "#1A7A6A",
  literal: "#2060B0",
  number: "#2E7D32",
  string: "#A04020",
  regexp: "#A01010",
  symbol: "#2E7D32",
  class: "#1A7A6A",
  function: "#6A5E00",
  title: "#6A5E00",
  params: "#205090",
  comment: "#4A7A30",
  doctag: "#3A6A20",
  meta: "#205090",
  "meta-keyword": "#7B30A0",
  "meta-string": "#A04020",
  section: "#6A5E00",
  tag: "#2060B0",
  name: "#205090",
  attr: "#205090",
  attribute: "#205090",
  variable: "#205090",
  bullet: "#8A6A00",
  code: "#A04020",
  formula: "#7B30A0",
  link: "#1A7A6A",
  quote: "#4A7A30",
  addition: "#2E7D32",
  deletion: "#A01010",
  "selector-tag": "#8A6A00",
  "selector-id": "#8A6A00",
  "selector-class": "#8A6A00",
  "selector-attr": "#8A6A00",
  "selector-pseudo": "#8A6A00",
  "template-tag": "#7B30A0",
  "template-variable": "#205090",
  default: "#111111",
};

// Dark syntax theme colors — original VS Code-like colors
const DARK_SYNTAX: Record<string, string> = {
  keyword: "#C586C0",
  built_in: "#4EC9B0",
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
  "meta-keyword": "#C586C0",
  "meta-string": "#CE9178",
  section: "#DCDCAA",
  tag: "#569CD6",
  name: "#9CDCFE",
  attr: "#9CDCFE",
  attribute: "#9CDCFE",
  variable: "#9CDCFE",
  bullet: "#D7BA7D",
  code: "#CE9178",
  formula: "#C586C0",
  link: "#4EC9B0",
  quote: "#6A9955",
  addition: "#B5CEA8",
  deletion: "#F44747",
  "selector-tag": "#D7BA7D",
  "selector-id": "#D7BA7D",
  "selector-class": "#D7BA7D",
  "selector-attr": "#D7BA7D",
  "selector-pseudo": "#D7BA7D",
  "template-tag": "#C586C0",
  "template-variable": "#9CDCFE",
};

/**
 * Apply light or dark syntax theme colors to an existing syntax theme object.
 * Mutates the theme in place via Object.assign.
 */
export function applySyntaxThemeVariant(
  syntaxTheme: HighlightTheme,
  isLight: boolean,
  fallback: (text: string) => string,
): void {
  const colors = isLight ? LIGHT_SYNTAX : DARK_SYNTAX;
  const updated: Record<string, ((text: string) => string) | typeof chalk.italic | typeof chalk.bold> = {};
  for (const [key, hex] of Object.entries(colors)) {
    updated[key] = chalk.hex(hex);
  }
  updated.emphasis = chalk.italic;
  updated.strong = chalk.bold;
  updated.default = isLight ? chalk.hex(LIGHT_SYNTAX.default!) : fallback;
  Object.assign(syntaxTheme, updated);
}
