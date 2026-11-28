import chalk from "chalk";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const originalChalkLevel = chalk.level;
chalk.level = 3;

const { markdownTheme, searchableSelectListTheme } = await import("./theme.js");

const escape = String.fromCharCode(27);
const stripAnsi = (str: string) => str.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

let themeImportCase = 0;

afterAll(() => {
  chalk.level = originalChalkLevel;
});

afterEach(() => vi.unstubAllEnvs());

type ThemeModule = typeof import("./theme.js");
const ansiRgbPattern = new RegExp(`${escape}\\[(38|48);2;(\\d+);(\\d+);(\\d+)m`, "u");

function colorFromStyle(style: (text: string) => string, layer: 38 | 48): string {
  const match = style("x").match(ansiRgbPattern);
  if (!match || Number(match[1]) !== layer) {
    throw new Error(`expected ${layer === 38 ? "foreground" : "background"} RGB style`);
  }
  return `#${match
    .slice(2, 5)
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

async function importThemeWithEnv(theme?: string, background?: string) {
  vi.stubEnv("OPENCLAW_THEME", theme);
  vi.stubEnv("COLORFGBG", background);
  return importFreshModule<ThemeModule>(import.meta.url, `./theme.js?env=${++themeImportCase}`);
}

function relativeLuminance(hex: string): number {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return (
      sum + weight * (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}

it("preserves multi-line code blocks", () => {
  const result = markdownTheme.highlightCode!("line-1\nline-2", "javascript");
  expect(result.map((line) => stripAnsi(line))).toEqual(["line-1", "line-2"]);
});

it.each([
  { name: "default", theme: undefined, background: undefined, light: false },
  { name: "case-insensitive override", theme: "LiGhT", background: undefined, light: true },
  { name: "override beats terminal", theme: "dark", background: "0;15", light: false },
  { name: "ANSI white", background: "0;15", light: true },
  { name: "ANSI silver", background: "0;7", light: true },
  { name: "ANSI bright black", background: "15;8", light: false },
  { name: "grayscale black", background: "15;232", light: false },
  { name: "grayscale white", background: "0;255", light: true },
  { name: "color cube black", background: "15;16", light: false },
  { name: "color cube green", background: "15;34", light: true },
  { name: "color cube cyan", background: "15;39", light: true },
  { name: "invalid background", background: "garbage", light: false },
  { name: "oversized background", background: "0;".repeat(40), light: false },
])("selects the expected palette for $name", async ({ theme, background, light }) => {
  const mod = await importThemeWithEnv(theme, background);
  expect(colorFromStyle(mod.tuiTheme.fg, 38) === "#1E1E1E").toBe(light);
});

it("keeps assistantText as identity in both modes", async () => {
  const lightMod = await importThemeWithEnv("light");
  const darkMod = await importThemeWithEnv("dark");
  expect(lightMod.tuiTheme.assistantText("hello")).toBe("hello");
  expect(darkMod.tuiTheme.assistantText("hello")).toBe("hello");
});

it("keeps light theme text colors at WCAG AA contrast or better", async () => {
  const { tuiTheme: tui, markdownTheme: md } = await importThemeWithEnv("light");
  const check = (foreground: (text: string) => string, background = "#FFFFFF") => {
    const fg = relativeLuminance(colorFromStyle(foreground, 38));
    const bg = relativeLuminance(background);
    expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
  };
  for (const style of [
    tui.fg,
    tui.dim,
    tui.accent,
    tui.accentSoft,
    tui.system,
    md.link,
    md.quote,
    tui.error,
    tui.success,
    md.code,
    tui.border,
    md.quoteBorder,
    md.codeBlockBorder,
  ]) {
    check(style);
  }
  check(tui.userText, colorFromStyle(tui.userBg, 48));
  for (const background of [tui.toolPendingBg, tui.toolSuccessBg, tui.toolErrorBg]) {
    for (const foreground of [tui.dim, tui.toolTitle, tui.toolOutput]) {
      check(foreground, colorFromStyle(background, 48));
    }
  }
});

it("keeps searchable list specific renderers readable", () => {
  expect(stripAnsi(searchableSelectListTheme.searchPrompt("Search:"))).toBe("Search:");
  expect(stripAnsi(searchableSelectListTheme.searchInput("query"))).toBe("query");
  expect(stripAnsi(searchableSelectListTheme.matchHighlight("match"))).toBe("match");
});
