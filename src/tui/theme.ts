import type { MarkdownTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold.cyan(text),
  link: (text) => chalk.blue(text),
  linkUrl: (text) => chalk.gray(text),
  code: (text) => chalk.yellow(text),
  codeBlock: (text) => chalk.yellow(text),
  codeBlockBorder: (text) => chalk.gray(text),
  quote: (text) => chalk.gray(text),
  quoteBorder: (text) => chalk.gray(text),
  hr: (text) => chalk.gray(text),
  listBullet: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};

export const theme = {
  header: (text: string) => chalk.bold.cyan(text),
  dim: (text: string) => chalk.gray(text),
  user: (text: string) => chalk.cyan(text),
  assistant: (text: string) => chalk.green(text),
  system: (text: string) => chalk.magenta(text),
  error: (text: string) => chalk.red(text),
};
