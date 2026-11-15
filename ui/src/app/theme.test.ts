// @vitest-environment node
// Control UI tests cover theme behavior.
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveTheme, type ThemeName } from "./theme.ts";

describe("resolveTheme", () => {
  it.each([
    ["claw", "dark", "light"],
    ["knot", "openknot", "openknot-light"],
    ["dash", "dash", "dash-light"],
  ] satisfies [ThemeName, string, string][])(
    "resolves %s in both explicit modes",
    (theme, dark, light) => {
      expect(resolveTheme(theme, "dark")).toBe(dark);
      expect(resolveTheme(theme, "light")).toBe(light);
    },
  );

  it("uses system preference when mode is system", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("knot", "system")).toBe("openknot-light");
    vi.unstubAllGlobals();
  });
});

describe("parseThemeSelection", () => {
  it("falls back to defaults for unknown stored values", () => {
    expect(parseThemeSelection("fieldmanual", "invalid-mode")).toEqual({
      theme: "claw",
      mode: "system",
    });
    expect(parseThemeSelection("dash", "light")).toEqual({
      theme: "dash",
      mode: "light",
    });
  });
});

// Exercise the real document-start owner, not just its runtime counterpart.
it.each([
  ["claw", "dark", "light"],
  ["knot", "openknot", "openknot-light"],
  ["dash", "dash", "dash-light"],
  ["absolutely", "absolutely", "absolutely-light"],
  ["tide", "tide", "tide-light"],
  ["beacon", "beacon", "beacon-light"],
  ["phosphor", "phosphor", "phosphor-light"],
  ["crt", "crt", "crt-light"],
  ["manuscript", "manuscript", "manuscript-light"],
  ["rose", "rose", "rose-light"],
  ["miami", "miami", "miami-light"],
])("keeps %s first-paint names and palette URLs in both modes", async (theme, dark, light) => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  for (const [mode, resolved] of [
    ["dark", dark],
    ["light", light],
  ]) {
    const page = new JSDOM(html, {
      url: "https://gateway.example/",
      runScripts: "dangerously",
      beforeParse(window) {
        window.localStorage.setItem(
          "openclaw.control.settings.v1",
          JSON.stringify({ theme, themeMode: mode }),
        );
      },
    });
    try {
      const root = page.window.document.documentElement;
      expect(root.dataset.theme).toBe(resolved);
      expect(root.dataset.themeMode).toBe(mode);
      expect(root.dataset.themeResolved).toBe(mode);
      const palettes = [
        ...root.querySelectorAll<HTMLLinkElement>('link[id^="openclaw-theme-palette-"]'),
      ];
      expect(palettes.map((link) => new URL(link.href).pathname)).toEqual(
        theme === "claw" ? [] : [`/themes/${theme}.css`],
      );
    } finally {
      page.window.close();
    }
  }
});
