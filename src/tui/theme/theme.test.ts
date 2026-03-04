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

    it("skips highlighting for long hex tokens (40+ chars) to prevent copy-paste corruption", () => {
      const longHex = "3ec1311e304d0b34d59fd8a4d4add0a8a3f8eba2d85c1a25";
      const result = markdownTheme.highlightCode!(longHex);
      // Should not call cli-highlight for credential-like strings
      expect(cliHighlightMocks.highlight).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      // Should still apply code color
      expect(stripAnsi(result[0] ?? "")).toBe(longHex);
    });

    it("skips highlighting for UUID format", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const result = markdownTheme.highlightCode!(uuid);
      expect(cliHighlightMocks.highlight).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(stripAnsi(result[0] ?? "")).toBe(uuid);
    });

    it("skips highlighting for base64-like tokens", () => {
      const token =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
      const result = markdownTheme.highlightCode!(token);
      expect(cliHighlightMocks.highlight).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(stripAnsi(result[0] ?? "")).toBe(token);
    });

    it("still highlights normal code", () => {
      const code = "const x = 42;";
      markdownTheme.highlightCode!(code);
      expect(cliHighlightMocks.highlight).toHaveBeenCalled();
    });

    it("still highlights multi-line credential-like content", () => {
      // Multi-line should still be highlighted (not treated as credential)
      const multiLineHex = "line1\n3ec1311e304d0b34d59fd8a4d4add0a8a3f8eba2d85c1a25";
      markdownTheme.highlightCode!(multiLineHex);
      expect(cliHighlightMocks.highlight).toHaveBeenCalled();
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
