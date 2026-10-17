// TUI theme tests cover theme defaults and environment-driven variants.

import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import chalk from "chalk";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../../test-utils/temp-dir.js";

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
  OPENCLAW_CONFIG_PATH?: string | undefined;
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

function readActivePalette(mod: ThemeModule) {
  return {
    text: colorFromStyle(mod.tuiTheme.fg, 38),
    dim: colorFromStyle(mod.tuiTheme.dim, 38),
    accent: colorFromStyle(mod.tuiTheme.accent, 38),
    accentSoft: colorFromStyle(mod.tuiTheme.accentSoft, 38),
    border: colorFromStyle(mod.tuiTheme.border, 38),
    userBg: colorFromStyle(mod.tuiTheme.userBg, 48),
    userText: colorFromStyle(mod.tuiTheme.userText, 38),
    systemText: colorFromStyle(mod.tuiTheme.system, 38),
    toolPendingBg: colorFromStyle(mod.tuiTheme.toolPendingBg, 48),
    toolSuccessBg: colorFromStyle(mod.tuiTheme.toolSuccessBg, 48),
    toolErrorBg: colorFromStyle(mod.tuiTheme.toolErrorBg, 48),
    toolTitle: colorFromStyle(mod.tuiTheme.toolTitle, 38),
    toolOutput: colorFromStyle(mod.tuiTheme.toolOutput, 38),
    quote: colorFromStyle(mod.markdownTheme.quote, 38),
    quoteBorder: colorFromStyle(mod.markdownTheme.quoteBorder, 38),
    code: colorFromStyle(mod.markdownTheme.code, 38),
    codeBorder: colorFromStyle(mod.markdownTheme.codeBlockBorder, 38),
    link: colorFromStyle(mod.markdownTheme.link, 38),
    error: colorFromStyle(mod.tuiTheme.error, 38),
    success: colorFromStyle(mod.tuiTheme.success, 38),
  };
}

async function importThemeWithEnv(env: ThemeEnvOverrides) {
  if (Object.hasOwn(env, "OPENCLAW_THEME")) {
    vi.stubEnv("OPENCLAW_THEME", env.OPENCLAW_THEME);
  }
  if (Object.hasOwn(env, "COLORFGBG")) {
    vi.stubEnv("COLORFGBG", env.COLORFGBG);
  }
  if (Object.hasOwn(env, "OPENCLAW_CONFIG_PATH")) {
    vi.stubEnv("OPENCLAW_CONFIG_PATH", env.OPENCLAW_CONFIG_PATH);
  }
  const mod = await importFreshModule<ThemeModule>(
    import.meta.url,
    `./theme.js?env=${++themeImportCase}`,
  );
  const lightPalette = readActivePalette(mod);
  return {
    ...mod,
    lightMode: lightPalette.text === "#1E1E1E",
    lightPalette,
  };
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
  return (
    0.2126 * expectDefined(channels[0], "channels[0] test invariant") +
    0.7152 * expectDefined(channels[1], "channels[1] test invariant") +
    0.0722 * expectDefined(channels[2], "channels[2] test invariant")
  );
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a,
  );
  return (
    (expectDefined(lighter, "lighter test invariant") + 0.05) /
    (expectDefined(darker, "darker test invariant") + 0.05)
  );
}

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    it("preserves multi-line code blocks", () => {
      const result = markdownTheme.highlightCode!("line-1\nline-2", "javascript");
      expect(result.map((line) => stripAnsi(line))).toEqual(["line-1", "line-2"]);
    });
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
    expect(mod.lightMode).toBe(light);
  });

  it("keeps assistantText as identity in both modes", async () => {
    const lightMod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    const darkMod = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
    expect(lightMod.tuiTheme.assistantText("hello")).toBe("hello");
    expect(darkMod.tuiTheme.assistantText("hello")).toBe("hello");
  });
});

describe("named themes", () => {
  async function importNamedTheme(dir: string, theme: string | undefined, background?: string) {
    if (theme !== undefined) {
      await fs.mkdir(path.join(dir, "themes"), { recursive: true });
      await fs.writeFile(path.join(dir, "themes", "night.json"), theme);
    }
    return importThemeWithEnv({
      OPENCLAW_THEME: "night",
      COLORFGBG: background,
      OPENCLAW_CONFIG_PATH: path.join(dir, "openclaw.json"),
    });
  }

  it("overrides only the listed colors on top of the chosen base palette", async () => {
    await withTempDir("openclaw-tui-theme-", async (dir) => {
      const dark = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
      const mod = await importNamedTheme(
        dir,
        JSON.stringify({ base: "dark", colors: { accent: "#82aaff", userBg: "#2f334d" } }),
        "0;15",
      );
      expect(mod.themeWarnings).toEqual([]);
      expect(mod.lightPalette).toEqual({
        ...dark.lightPalette,
        accent: "#82AAFF",
        userBg: "#2F334D",
      });
    });
  });

  it("keeps base colors for invalid entries and reports one notice per kind", async () => {
    await withTempDir("openclaw-tui-theme-", async (dir) => {
      const mod = await importNamedTheme(
        dir,
        JSON.stringify({
          name: "Night",
          base: "dim",
          colours: {},
          colors: { accent: "blue", glow: "#000000", link: "#65bcff", shine: "#ffffff", dim: 1 },
        }),
      );
      expect(mod.lightPalette.accent).toBe("#F6C453");
      expect(mod.lightPalette.link).toBe("#65BCFF");
      expect(mod.themeWarnings).toEqual([
        'theme "night": unknown keys ignored: colours',
        'theme "night": base must be "dark" or "light"',
        'theme "night": unknown colors ignored: glow, shine',
        'theme "night": colors must be #RRGGBB hex strings: accent, dim',
      ]);
    });
  });

  it("lists at most five names in a notice", async () => {
    await withTempDir("openclaw-tui-theme-", async (dir) => {
      const colors = Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [`extra${index + 1}`, "#000000"]),
      );
      const mod = await importNamedTheme(dir, JSON.stringify({ colors }));
      expect(mod.themeWarnings).toEqual([
        'theme "night": unknown colors ignored: extra1, extra2, extra3, extra4, extra5 and 2 more',
      ]);
    });
  });

  it("falls back to the detected palette when the theme file cannot be used", async () => {
    await withTempDir("openclaw-tui-theme-", async (dir) => {
      const light = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
      const missing = await importNamedTheme(dir, undefined, "0;15");
      expect(missing.lightPalette).toEqual(light.lightPalette);
      expect(missing.themeWarnings).toEqual([
        `theme "night": ${path.join(dir, "themes", "night.json")} not found; using the built-in palette`,
      ]);

      const malformed = await importNamedTheme(dir, "{ not json", "0;15");
      expect(malformed.lightPalette).toEqual(light.lightPalette);
      expect(malformed.themeWarnings).toHaveLength(1);
      expect(malformed.themeWarnings[0]).toContain("cannot load");
    });
  });
});

describe("light palette accessibility", () => {
  it("keeps light theme text colors at WCAG AA contrast or better", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    const backgrounds = {
      page: "#FFFFFF",
      user: mod.lightPalette.userBg,
      pending: mod.lightPalette.toolPendingBg,
      success: mod.lightPalette.toolSuccessBg,
      error: mod.lightPalette.toolErrorBg,
      code: "#FFFFFF",
    };

    const textPairs = [
      [mod.lightPalette.text, backgrounds.page],
      [mod.lightPalette.dim, backgrounds.page],
      [mod.lightPalette.accent, backgrounds.page],
      [mod.lightPalette.accentSoft, backgrounds.page],
      [mod.lightPalette.systemText, backgrounds.page],
      [mod.lightPalette.link, backgrounds.page],
      [mod.lightPalette.quote, backgrounds.page],
      [mod.lightPalette.error, backgrounds.page],
      [mod.lightPalette.success, backgrounds.page],
      [mod.lightPalette.userText, backgrounds.user],
      [mod.lightPalette.dim, backgrounds.pending],
      [mod.lightPalette.dim, backgrounds.success],
      [mod.lightPalette.dim, backgrounds.error],
      [mod.lightPalette.toolTitle, backgrounds.pending],
      [mod.lightPalette.toolTitle, backgrounds.success],
      [mod.lightPalette.toolTitle, backgrounds.error],
      [mod.lightPalette.toolOutput, backgrounds.pending],
      [mod.lightPalette.toolOutput, backgrounds.success],
      [mod.lightPalette.toolOutput, backgrounds.error],
      [mod.lightPalette.code, backgrounds.code],
      [mod.lightPalette.border, backgrounds.page],
      [mod.lightPalette.quoteBorder, backgrounds.page],
      [mod.lightPalette.codeBorder, backgrounds.page],
    ] as const;

    for (const [foreground, background] of textPairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
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
