import { describe, expect, it } from "vitest";
import { replaceManagedMarkdownBlock, withTrailingNewline } from "./memory-host-markdown.js";

describe("withTrailingNewline", () => {
  it("preserves trailing newlines", () => {
    expect(withTrailingNewline("hello\n")).toBe("hello\n");
  });

  it("adds a trailing newline when missing", () => {
    expect(withTrailingNewline("hello")).toBe("hello\n");
  });
});

describe("replaceManagedMarkdownBlock", () => {
  it("replaces the complete outer block when generated blocks are nested", () => {
    const params = {
      heading: "## Generated",
      startMarker: "<!-- start -->",
      endMarker: "<!-- end -->",
      body: "current",
    };
    const original = [
      "# Title",
      "",
      "## Generated",
      "<!-- start -->",
      "outer before",
      "<!-- start -->",
      "inner stale",
      "<!-- end -->",
      "outer stale tail",
      "<!-- end -->",
      "",
      "Human history",
      "",
    ].join("\n");
    const updated = replaceManagedMarkdownBlock({ original, ...params });
    expect(updated).toBe(
      [
        "# Title",
        "",
        "## Generated",
        "<!-- start -->",
        "current",
        "<!-- end -->",
        "",
        "Human history",
        "",
      ].join("\n"),
    );
    expect(replaceManagedMarkdownBlock({ original: updated, ...params })).toBe(updated);
  });

  it("ignores standalone marker examples in inline and fenced code", () => {
    const original = [
      "# Human history",
      "Use <!-- start --> and <!-- end --> as examples.",
      "`<!-- start -->`",
      "",
      "```markdown",
      "<!-- start -->",
      "Human code sample",
      "<!-- end -->",
      "```",
      "",
      "    <!-- start -->",
      "    Indented code sample",
      "    <!-- end -->",
      "\t<!-- start -->",
      "\tTabbed code sample",
      "\t<!-- end -->",
      "",
      "## Generated",
      "<!-- start -->",
      "stale",
      "<!-- end -->",
    ].join("\n");

    expect(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "current",
      }),
    ).toBe(original.replace("stale", "current"));
  });

  it("removes surplus end marker bytes only after finding a balanced block", () => {
    const original = [
      "Outside history.",
      "<!-- end -->",
      "## Generated",
      "<!-- start -->",
      "stale",
      "<!-- end -->",
      "More history.",
      "<!-- end -->",
    ].join("\n");
    const updated = replaceManagedMarkdownBlock({
      original,
      heading: "## Generated",
      startMarker: "<!-- start -->",
      endMarker: "<!-- end -->",
      body: "current",
    });

    expect(updated).toBe(
      [
        "Outside history.",
        "",
        "## Generated",
        "<!-- start -->",
        "current",
        "<!-- end -->",
        "More history.",
        "",
      ].join("\n"),
    );
    expect(updated.split("<!-- end -->")).toHaveLength(2);
  });

  it("rejects orphan-only and unclosed marker sequences", () => {
    const params = {
      startMarker: "<!-- start -->",
      endMarker: "<!-- end -->",
      body: "current",
    };

    expect(() =>
      replaceManagedMarkdownBlock({
        original: "Outside history.\n<!-- end -->",
        ...params,
      }),
    ).toThrow("restore the missing start marker");
    expect(() =>
      replaceManagedMarkdownBlock({
        original: "<!-- start -->\nold\n<!-- end -->\n<!-- start -->\nunclosed",
        ...params,
      }),
    ).toThrow("restore the missing end marker");
  });

  it("appends a managed block when missing", () => {
    expect(
      replaceManagedMarkdownBlock({
        original: "# Title\n",
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- first",
      }),
    ).toBe("# Title\n\n## Generated\n<!-- start -->\n- first\n<!-- end -->\n");
  });

  it("replaces an existing managed block in place", () => {
    expect(
      replaceManagedMarkdownBlock({
        original:
          "# Title\n\n## Generated\n<!-- start -->\n- old\n<!-- end -->\n\n## Notes\nkept\n",
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- new",
      }),
    ).toBe("# Title\n\n## Generated\n<!-- start -->\n- new\n<!-- end -->\n\n## Notes\nkept\n");
  });

  it("supports headingless blocks", () => {
    expect(
      replaceManagedMarkdownBlock({
        original: "alpha\n",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "beta",
      }),
    ).toBe("alpha\n\n<!-- start -->\nbeta\n<!-- end -->\n");
  });

  it("replaces headed blocks with CRLF line endings in place", () => {
    expect(
      replaceManagedMarkdownBlock({
        original: "# Title\r\n\r\n## Generated\r\n<!-- start -->\r\n- old\r\n<!-- end -->\r\n",
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- new",
      }),
    ).toBe("# Title\r\n\r\n## Generated\n<!-- start -->\n- new\n<!-- end -->\r\n");
  });

  it("preserves unmanaged markdown while removing duplicate blocks", () => {
    const original = [
      "# Title",
      "",
      "Paragraph A",
      "",
      "",
      "Paragraph B",
      "",
      "## Generated",
      "<!-- start -->",
      "- old",
      "<!-- end -->",
      "",
      "## Generated",
      "<!-- start -->",
      "- stale",
      "<!-- end -->",
      "",
      "## Notes",
      "kept",
      "",
      "",
    ].join("\n");

    expect(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Generated",
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "- new",
      }),
    ).toBe(
      "# Title\n\nParagraph A\n\n\nParagraph B\n\n## Generated\n<!-- start -->\n- new\n<!-- end -->\n\n## Notes\nkept\n\n",
    );
  });

  it("is idempotent across repeated calls with the same body", () => {
    const params = {
      heading: "## Generated",
      startMarker: "<!-- start -->",
      endMarker: "<!-- end -->",
      body: "- only",
    } as const;
    const first = replaceManagedMarkdownBlock({ original: "# Title\n", ...params });
    const second = replaceManagedMarkdownBlock({ original: first, ...params });
    const third = replaceManagedMarkdownBlock({ original: second, ...params });

    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
