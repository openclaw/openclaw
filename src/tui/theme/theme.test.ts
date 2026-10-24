import chalk from "chalk";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalChalkLevel = chalk.level;
chalk.level = 3;

const { markdownTheme, searchableSelectListTheme } = await import("./theme.js");

const stripAnsi = (str: string) =>
  str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

let themeImportCase = 0;

afterAll(() => {
  chalk.level = originalChalkLevel;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type ThemeEnvOverrides = {
  OPENCLAW_THEME?: string | undefined;
  COLORFGBG?: string | undefined;
};

type ThemeModule = typeof import("./theme.js");
const ansiRgbPattern = new RegExp(
  `${String.fromCharCode(27)}\\[(38|48);2;(\\d+);(\\d+);(\\d+)m`,
  "u",
);

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

async function importThemeWithEnv(env: ThemeEnvOverrides) {
  if (Object.hasOwn(env, "OPENCLAW_THEME")) {
    vi.stubEnv("OPENCLAW_THEME", env.OPENCLAW_THEME);
  }
  if (Object.hasOwn(env, "COLORFGBG")) {
    vi.stubEnv("COLORFGBG", env.COLORFGBG);
  }
  return importFreshModule<ThemeModule>(import.meta.url, `./theme.js?env=${++themeImportCase}`);
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) {
    throw new Error(`invalid color: ${hex}`);
  }
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

describe("markdownTheme.highlightCode", () => {
  it("preserves multi-line code blocks", () => {
    const result = markdownTheme.highlightCode!("line-1\nline-2", "javascript");
    expect(result.map((line) => stripAnsi(line))).toEqual(["line-1", "line-2"]);
  });
});

describe("light background detection", () => {
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
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: theme, COLORFGBG: background });
    expect(colorFromStyle(mod.tuiTheme.fg, 38) === "#1E1E1E").toBe(light);
  });

  it("keeps assistantText as identity in both modes", async () => {
    const lightMod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    const darkMod = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
    expect(lightMod.tuiTheme.assistantText("hello")).toBe("hello");
    expect(darkMod.tuiTheme.assistantText("hello")).toBe("hello");
  });
});

describe("light palette accessibility", () => {
  it("keeps light theme text colors at WCAG AA contrast or better", async () => {
    const { tuiTheme: tui, markdownTheme: md } = await importThemeWithEnv({
      OPENCLAW_THEME: "light",
    });
    const check = (foreground: (text: string) => string, background = "#FFFFFF") => {
      expect(contrastRatio(colorFromStyle(foreground, 38), background)).toBeGreaterThanOrEqual(4.5);
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
});

describe("list themes", () => {
  it("keeps searchable list specific renderers readable", () => {
    expect(stripAnsi(searchableSelectListTheme.searchPrompt("Search:"))).toBe("Search:");
    expect(stripAnsi(searchableSelectListTheme.searchInput("query"))).toBe("query");
    expect(stripAnsi(searchableSelectListTheme.matchHighlight("match"))).toBe("match");
  });
});
