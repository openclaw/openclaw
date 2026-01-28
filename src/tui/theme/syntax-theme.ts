import chalk from "chalk";

type HighlightTheme = Record<string, (text: string) => string>;

/**
 * Syntax highlighting theme for code blocks.
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
