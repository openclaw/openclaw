import chalk from "chalk";

type HighlightTheme = Record<string, (text: string) => string>;

/**
 * Syntax highlighting theme for code blocks (dark background).
 * Uses chalk functions to style different token types.
 */
export function createSyntaxTheme(fallback: (text: string) => string): HighlightTheme {
  return {
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
    default: fallback, // fallback to code color
  };
}

/**
 * Syntax highlighting theme for code blocks (light background).
 * Colors chosen for readability on white/light terminals.
 */
export function createLightSyntaxTheme(fallback: (text: string) => string): HighlightTheme {
  return {
    keyword: chalk.hex("#AF00DB"), // purple
    built_in: chalk.hex("#267F99"), // teal
    type: chalk.hex("#267F99"), // teal
    literal: chalk.hex("#0000FF"), // blue
    number: chalk.hex("#098658"), // green
    string: chalk.hex("#A31515"), // red-brown
    regexp: chalk.hex("#811F3F"), // dark red
    symbol: chalk.hex("#098658"), // green
    class: chalk.hex("#267F99"), // teal
    function: chalk.hex("#795E26"), // dark yellow
    title: chalk.hex("#795E26"), // dark yellow
    params: chalk.hex("#001080"), // dark blue
    comment: chalk.hex("#008000"), // green
    doctag: chalk.hex("#008000"), // green
    meta: chalk.hex("#001080"), // dark blue
    "meta-keyword": chalk.hex("#AF00DB"), // purple
    "meta-string": chalk.hex("#A31515"), // red-brown
    section: chalk.hex("#795E26"), // dark yellow
    tag: chalk.hex("#800000"), // dark red
    name: chalk.hex("#001080"), // dark blue
    attr: chalk.hex("#E50000"), // red
    attribute: chalk.hex("#E50000"), // red
    variable: chalk.hex("#001080"), // dark blue
    bullet: chalk.hex("#795E26"), // dark yellow
    code: chalk.hex("#A31515"), // red-brown
    emphasis: chalk.italic,
    strong: chalk.bold,
    formula: chalk.hex("#AF00DB"), // purple
    link: chalk.hex("#267F99"), // teal
    quote: chalk.hex("#008000"), // green
    addition: chalk.hex("#098658"), // green
    deletion: chalk.hex("#A31515"), // red
    "selector-tag": chalk.hex("#800000"), // dark red
    "selector-id": chalk.hex("#001080"), // dark blue
    "selector-class": chalk.hex("#795E26"), // dark yellow
    "selector-attr": chalk.hex("#795E26"), // dark yellow
    "selector-pseudo": chalk.hex("#795E26"), // dark yellow
    "template-tag": chalk.hex("#AF00DB"), // purple
    "template-variable": chalk.hex("#001080"), // dark blue
    default: fallback,
  };
}
