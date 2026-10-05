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

  it("does not let an unmatched inline delimiter hide a balanced managed end", () => {
    const original = [
      "## Generated",
      "<!-- start -->",
      "stale text with an unmatched ` delimiter",
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
    ).toBe(["## Generated", "<!-- start -->", "current", "<!-- end -->"].join("\n"));
  });

  it("preserves inline recovery markers inside indented code", () => {
    const original = [
      "<!-- start -->",
      "stale",
      "<!-- end -->",
      "",
      "    literal example<!-- end -->",
      "\tliteral example<!-- end -->",
    ].join("\n");

    expect(
      replaceManagedMarkdownBlock({
        original,
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "current",
        recoverInlineOrphanEnds: true,
      }),
    ).toBe(
      [
        "<!-- start -->",
        "current",
        "<!-- end -->",
        "",
        "    literal example<!-- end -->",
        "\tliteral example<!-- end -->",
      ].join("\n"),
    );
  });

  it("keeps an unterminated trailing fence as code during recovery", () => {
    const original = [
      "<!-- start -->",
      "stale",
      "<!-- end -->",
      "",
      "```markdown",
      "literal<!-- end -->",
    ].join("\n");

    expect(
      replaceManagedMarkdownBlock({
        original,
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "current",
        recoverInlineOrphanEnds: true,
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

  it.each(["\n", "\r\n"])(
    "recovers a trailing inline orphan without changing history (%j)",
    (newline) => {
      const params = {
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "current",
        recoverInlineOrphanEnds: true,
      };
      const history = `## History — 2026-10-03${newline}Retained dated event [Event 9f55].`;
      const examples = [
        "Use <!-- start --> and <!-- end -->",
        "Literal <!-- end -->",
        "Escaped \\<!-- end -->",
        "Use <!-- end --> within prose.",
        "`code <!-- end -->`",
        "```md",
        "code <!-- end -->",
        "```",
      ].join(newline);
      const prefix = `<!-- start -->${newline}stale${newline}<!-- end -->${newline}`;
      const original = `${prefix}${history}<!-- end -->  ${newline}${history}${newline}${examples}${newline}`;
      const updated = replaceManagedMarkdownBlock({ original, ...params });
      expect(updated).toBe(
        `<!-- start -->\ncurrent\n<!-- end -->${newline}${history}  ${newline}${history}${newline}${examples}${newline}`,
      );
      expect(replaceManagedMarkdownBlock({ original: updated, ...params })).toBe(updated);
    },
  );

  it("does not use an inline end as a closing boundary or as an unanchored repair", () => {
    const params = { startMarker: "<!-- start -->", endMarker: "<!-- end -->", body: "current" };
    expect(() =>
      replaceManagedMarkdownBlock({ original: "<!-- start -->\nprose<!-- end -->", ...params }),
    ).toThrow("restore the missing end marker");
    const original = "Unowned prose<!-- end -->\n";
    expect(replaceManagedMarkdownBlock({ original, ...params })).toBe(
      `${original}\n<!-- start -->\ncurrent\n<!-- end -->\n`,
    );
  });

  it("preserves inline marker-like prose unless the caller opts into recovery", () => {
    const original = "<!-- start -->\nold\n<!-- end -->\n## Notes\nkeep<!-- end -->\n";
    expect(
      replaceManagedMarkdownBlock({
        original,
        startMarker: "<!-- start -->",
        endMarker: "<!-- end -->",
        body: "current",
      }),
    ).toBe("<!-- start -->\ncurrent\n<!-- end -->\n## Notes\nkeep<!-- end -->\n");
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
