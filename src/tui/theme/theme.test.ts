import { beforeEach, describe, expect, it, vi } from "vitest";

const cliHighlightMocks = vi.hoisted(() => ({
  highlight: vi.fn((code: string) => code),
  supportsLanguage: vi.fn((_lang: string) => true),
}));

vi.mock("cli-highlight", () => cliHighlightMocks);

const {
  applyTheme,
  filterableSelectListTheme,
  markdownTheme,
  searchableSelectListTheme,
  selectListTheme,
  theme,
} = await import("./theme.js");

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
  it("applies palette text color to assistant text", () => {
    expect(stripAnsi(theme.assistantText("hello"))).toBe("hello");
  });

  it("resets terminal fg/bg when applying a theme without terminal background", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    applyTheme("default");
    const writes = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((w) => w.includes("\x1b]110\x07"))).toBe(true);
    expect(writes.some((w) => w.includes("\x1b]111\x07"))).toBe(true);
    writeSpy.mockRestore();
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

  it("keeps filterable select-list renderers in sync after theme changes", () => {
    applyTheme("default");
    const beforeSelectedPrefix = filterableSelectListTheme.selectedPrefix;
    const beforeFilterLabel = filterableSelectListTheme.filterLabel;

    applyTheme("matrix");

    expect(filterableSelectListTheme.selectedPrefix).not.toBe(beforeSelectedPrefix);
    expect(filterableSelectListTheme.filterLabel).not.toBe(beforeFilterLabel);
  });

  it("keeps searchable list specific renderers readable", () => {
    expect(stripAnsi(searchableSelectListTheme.searchPrompt("Search:"))).toBe("Search:");
    expect(stripAnsi(searchableSelectListTheme.searchInput("query"))).toBe("query");
    expect(stripAnsi(searchableSelectListTheme.matchHighlight("match"))).toBe("match");
  });
});
