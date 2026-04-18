import { describe, expect, it } from "vitest";
import {
  replaceManagedMarkdownBlock,
  stripDreamingManagedBlocks,
  withTrailingNewline,
} from "./memory-host-markdown.js";

describe("withTrailingNewline", () => {
  it("preserves trailing newlines", () => {
    expect(withTrailingNewline("hello\n")).toBe("hello\n");
  });

  it("adds a trailing newline when missing", () => {
    expect(withTrailingNewline("hello")).toBe("hello\n");
  });
});

describe("replaceManagedMarkdownBlock", () => {
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
});

describe("stripDreamingManagedBlocks", () => {
  it("returns content unchanged when no dreaming blocks present", () => {
    const input = "# Daily Log\n\n- did something\n- learned something\n";
    expect(stripDreamingManagedBlocks(input)).toBe(input);
  });

  it("strips a light sleep block with heading", () => {
    const input = [
      "# Daily Log",
      "",
      "- did something",
      "",
      "## Light Sleep",
      "<!-- openclaw:dreaming:light:start -->",
      "- candidate 1",
      "- candidate 2",
      "<!-- openclaw:dreaming:light:end -->",
      "",
      "## Notes",
      "kept",
      "",
    ].join("\n");
    const result = stripDreamingManagedBlocks(input);
    expect(result).toContain("# Daily Log");
    expect(result).toContain("- did something");
    expect(result).toContain("## Notes");
    expect(result).toContain("kept");
    expect(result).not.toContain("Light Sleep");
    expect(result).not.toContain("candidate 1");
    expect(result).not.toContain("openclaw:dreaming");
  });

  it("strips a REM sleep block with heading", () => {
    const input = [
      "# Log",
      "",
      "## REM Sleep",
      "<!-- openclaw:dreaming:rem:start -->",
      "dream narrative here",
      "<!-- openclaw:dreaming:rem:end -->",
      "",
    ].join("\n");
    const result = stripDreamingManagedBlocks(input);
    expect(result).toContain("# Log");
    expect(result).not.toContain("REM Sleep");
    expect(result).not.toContain("dream narrative");
  });

  it("strips both light and REM blocks from the same document", () => {
    const input = [
      "# Daily Log",
      "",
      "- user content",
      "",
      "## Light Sleep",
      "<!-- openclaw:dreaming:light:start -->",
      "- light candidate",
      "<!-- openclaw:dreaming:light:end -->",
      "",
      "## REM Sleep",
      "<!-- openclaw:dreaming:rem:start -->",
      "- rem narrative",
      "<!-- openclaw:dreaming:rem:end -->",
      "",
      "## My Notes",
      "important stuff",
      "",
    ].join("\n");
    const result = stripDreamingManagedBlocks(input);
    expect(result).toContain("- user content");
    expect(result).toContain("## My Notes");
    expect(result).toContain("important stuff");
    expect(result).not.toContain("Light Sleep");
    expect(result).not.toContain("REM Sleep");
    expect(result).not.toContain("candidate");
    expect(result).not.toContain("narrative");
  });

  it("strips a block without its heading (marker-only)", () => {
    const input = [
      "# Log",
      "",
      "<!-- openclaw:dreaming:light:start -->",
      "- orphan candidate",
      "<!-- openclaw:dreaming:light:end -->",
      "",
      "real content",
      "",
    ].join("\n");
    const result = stripDreamingManagedBlocks(input);
    expect(result).toContain("# Log");
    expect(result).toContain("real content");
    expect(result).not.toContain("orphan candidate");
  });

  it("collapses excessive blank lines after stripping", () => {
    const input = [
      "before",
      "",
      "",
      "## Light Sleep",
      "<!-- openclaw:dreaming:light:start -->",
      "- stuff",
      "<!-- openclaw:dreaming:light:end -->",
      "",
      "",
      "after",
    ].join("\n");
    const result = stripDreamingManagedBlocks(input);
    // No run of 3+ consecutive newlines should remain
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain("before");
    expect(result).toContain("after");
  });
});
