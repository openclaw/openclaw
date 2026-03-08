import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliHighlightMocks = vi.hoisted(() => ({
  highlight: vi.fn((code: string) => code),
  supportsLanguage: vi.fn((_lang: string) => true),
}));

vi.mock("cli-highlight", () => cliHighlightMocks);

const { markdownTheme, searchableSelectListTheme, selectListTheme, theme } =
  await import("./theme.js");

const stripAnsi = (str: string) =>
  str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    beforeEach(() => {
      cliHighlightMocks.highlight.mockClear();
      cliHighlightMocks.supportsLanguage.mockClear();
      cliHighlightMocks.highlight.mockImplementation((code: string) => code);
      cliHighlightMocks.supportsLanguage.mockReturnValue(true);
    });

    it("passes supported language through to the highlighter", () => {
      markdownTheme.highlightCode!("const x = 42;", "javascript");
      expect(cliHighlightMocks.supportsLanguage).toHaveBeenCalledWith("javascript");
      expect(cliHighlightMocks.highlight).toHaveBeenCalledWith(
        "const x = 42;",
        expect.objectContaining({ language: "javascript" }),
      );
    });

    it("falls back to auto-detect for unknown language and preserves lines", () => {
      cliHighlightMocks.supportsLanguage.mockReturnValue(false);
      cliHighlightMocks.highlight.mockImplementation((code: string) => `${code}\nline-2`);
      const result = markdownTheme.highlightCode!(`echo "hello"`, "not-a-real-language");
      expect(cliHighlightMocks.highlight).toHaveBeenCalledWith(
        `echo "hello"`,
        expect.objectContaining({ language: undefined }),
      );
      expect(stripAnsi(result[0] ?? "")).toContain("echo");
      expect(stripAnsi(result[1] ?? "")).toBe("line-2");
    });

    it("returns plain highlighted lines when highlighting throws", () => {
      cliHighlightMocks.highlight.mockImplementation(() => {
        throw new Error("boom");
      });
      const result = markdownTheme.highlightCode!("echo hello", "javascript");
      expect(result).toHaveLength(1);
      expect(stripAnsi(result[0] ?? "")).toBe("echo hello");
    });
  });
});

describe("theme", () => {
  it("keeps assistant text in terminal default foreground", () => {
    expect(theme.assistantText("hello")).toBe("hello");
    expect(stripAnsi(theme.assistantText("hello"))).toBe("hello");
  });
});

describe("light background detection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  async function importThemeWithEnv(env: Record<string, string | undefined>) {
    // Reset so we get a fresh module evaluation with new env vars
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    return import("./theme.js");
  }

  it("uses dark palette by default", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: undefined,
    });
    expect(mod.lightMode).toBe(false);
  });

  it("selects light palette when OPENCLAW_THEME=light", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    expect(mod.lightMode).toBe(true);
  });

  it("selects dark palette when OPENCLAW_THEME=dark", async () => {
    const mod = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
    expect(mod.lightMode).toBe(false);
  });

  it("detects light background from COLORFGBG", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;15",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats COLORFGBG bg=7 (silver) as light", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;7",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats COLORFGBG bg=8 (bright black / dark gray) as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;8",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats COLORFGBG bg < 7 as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;0",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats 256-color COLORFGBG bg=232 (near-black greyscale) as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;232",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("treats 256-color COLORFGBG bg=255 (near-white greyscale) as light", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;255",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats 256-color COLORFGBG bg=231 (white cube entry) as light", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "0;231",
    });
    expect(mod.lightMode).toBe(true);
  });

  it("treats 256-color COLORFGBG bg=16 (black cube entry) as dark", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: undefined,
      COLORFGBG: "15;16",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("OPENCLAW_THEME overrides COLORFGBG", async () => {
    const mod = await importThemeWithEnv({
      OPENCLAW_THEME: "dark",
      COLORFGBG: "0;15",
    });
    expect(mod.lightMode).toBe(false);
  });

  it("keeps assistantText as identity in both modes", async () => {
    const lightMod = await importThemeWithEnv({ OPENCLAW_THEME: "light" });
    const darkMod = await importThemeWithEnv({ OPENCLAW_THEME: "dark" });
    expect(lightMod.theme.assistantText("hello")).toBe("hello");
    expect(darkMod.theme.assistantText("hello")).toBe("hello");
  });
});

describe("list themes", () => {
  it("reuses shared select-list styles in searchable list theme", () => {
    expect(searchableSelectListTheme.selectedPrefix(">")).toBe(selectListTheme.selectedPrefix(">"));
    expect(searchableSelectListTheme.selectedText("entry")).toBe(
      selectListTheme.selectedText("entry"),
    );
    expect(searchableSelectListTheme.description("desc")).toBe(selectListTheme.description("desc"));
    expect(searchableSelectListTheme.scrollInfo("scroll")).toBe(
      selectListTheme.scrollInfo("scroll"),
    );
    expect(searchableSelectListTheme.noMatch("none")).toBe(selectListTheme.noMatch("none"));
  });

  it("keeps searchable list specific renderers readable", () => {
    expect(stripAnsi(searchableSelectListTheme.searchPrompt("Search:"))).toBe("Search:");
    expect(stripAnsi(searchableSelectListTheme.searchInput("query"))).toBe("query");
    expect(stripAnsi(searchableSelectListTheme.matchHighlight("match"))).toBe("match");
  });
});
