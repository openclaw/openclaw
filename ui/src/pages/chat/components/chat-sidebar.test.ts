/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  computeFileSearchMatches,
  editorOpenUrl,
  renderMarkdownSidebar,
  splitHighlightedHtmlIntoLines,
} from "./chat-sidebar.ts";

describe("computeFileSearchMatches", () => {
  it("finds matching line numbers", () => {
    expect(computeFileSearchMatches("alpha\nbeta\ngamma", "beta")).toEqual([2]);
  });

  it("matches case-insensitively", () => {
    expect(computeFileSearchMatches("Alpha\nBETA", "alpha")).toEqual([1]);
  });

  it("returns no matches for an empty query", () => {
    expect(computeFileSearchMatches("alpha\nbeta", "")).toEqual([]);
  });

  it("returns every matching line once", () => {
    expect(computeFileSearchMatches("match match\nnope\nMATCH", "match")).toEqual([1, 3]);
  });
});

describe("editorOpenUrl", () => {
  it("creates a custom editor URL for a plain path", () => {
    expect(editorOpenUrl("cursor", "/workspace/src/foo.ts")).toBe(
      "cursor://file/workspace/src/foo.ts",
    );
  });

  it("encodes spaces in paths", () => {
    expect(editorOpenUrl("vscode", "/workspace/My File.ts")).toBe(
      "vscode://file/workspace/My%20File.ts",
    );
  });

  it("appends a target line", () => {
    expect(editorOpenUrl("zed", "/workspace/src/foo.ts", 42)).toBe(
      "zed://file/workspace/src/foo.ts:42",
    );
  });
});

describe("splitHighlightedHtmlIntoLines", () => {
  it("closes and reopens highlighted spans across lines", () => {
    expect(splitHighlightedHtmlIntoLines('<span class="hljs-keyword">const\nlet</span>')).toEqual([
      '<span class="hljs-keyword">const</span>',
      '<span class="hljs-keyword">let</span>',
    ]);
  });

  it("passes plain highlighted text through line by line", () => {
    expect(splitHighlightedHtmlIntoLines("first\nsecond")).toEqual(["first", "second"]);
  });
});

describe("file sidebar", () => {
  it("renders line-number gutters and marks the requested line", () => {
    const container = document.createElement("div");
    render(
      renderMarkdownSidebar({
        content: {
          kind: "file",
          path: "src/lib/foo.ts",
          name: "foo.ts",
          content: "const first = 1;\nconst second = 2;",
          language: "ts",
          line: 2,
          rawText: "const first = 1;\nconst second = 2;",
        },
        error: null,
        onClose: () => undefined,
        onViewRawText: () => undefined,
      }),
      container,
    );

    const lines = container.querySelectorAll<HTMLElement>(".file-view__line");
    expect(lines).toHaveLength(2);
    expect([...lines].map((line) => line.dataset.line)).toEqual(["1", "2"]);
    expect(container.querySelector(".file-view__line--target")?.getAttribute("data-line")).toBe(
      "2",
    );
    expect(container.querySelector(".sidebar-file-view__path")?.textContent).toBe("src/lib/foo.ts");
  });
});
