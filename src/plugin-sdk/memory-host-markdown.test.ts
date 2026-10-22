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
});
