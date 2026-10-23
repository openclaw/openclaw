import { afterEach, expect, it } from "vitest";
import { createThemePaletteFixture } from "../../../../test/helpers/theme-fixture.ts";
import { syncCustomThemeStyleTag } from "../../app/custom-theme.ts";
import { normalizeThemePalette } from "../../app/theme-palette.ts";
import { terminalTheme } from "./terminal-theme.ts";

afterEach(() => {
  syncCustomThemeStyleTag(null);
  document.documentElement.removeAttribute("data-theme");
});

it("carries authored terminal colors through palette normalization and the managed stylesheet", () => {
  const palette = normalizeThemePalette(
    "dark",
    createThemePaletteFixture({ "terminal-red": "#f38ba8", "terminal-bright-blue": "#89b4fa" }),
    undefined,
  );
  syncCustomThemeStyleTag({ light: palette, dark: palette });
  document.documentElement.dataset.theme = "custom";
  expect(terminalTheme("dark")).toMatchObject({ red: "#f38ba8", brightBlue: "#89b4fa" });

  const unthemed = normalizeThemePalette("dark", createThemePaletteFixture(), undefined);
  syncCustomThemeStyleTag({ light: unthemed, dark: unthemed });
  expect(terminalTheme("dark")).toMatchObject({ red: "#ff6b6b", brightBlue: "#7cb7ff" });
  expect(terminalTheme("light").red).toBe("#c62f3d");
});
