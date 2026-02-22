import { beforeEach, describe, expect, it, vi } from "vitest";

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
