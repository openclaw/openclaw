// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { stripProgressCardRawContentBlocks } from "./markdown-raw-content.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("progress-card markdown", () => {
  it("allows only progress markup when explicitly enabled", () => {
    const markdown =
      '<progress value="3" max="7" onclick="alert(1)"></progress><script>alert(2)</script>';

    const defaultHtml = toSanitizedMarkdownHtml(markdown);
    const progressHtml = toSanitizedMarkdownHtml(markdown, { progressBars: true });

    expect(defaultHtml).not.toContain("<progress");
    expect(progressHtml).toContain('<progress value="3" max="7"></progress>');
    expect(progressHtml).not.toContain("onclick");
    expect(progressHtml).not.toContain("<script");
    expect(progressHtml).not.toContain("alert(2)");
  });

  it("preserves raw-content block removal semantics", () => {
    const markdown =
      'before<SCRIPT data-test="true">alert(1)</script >' +
      "middle<style>body{display:none}</style><template>hidden</template>after";

    expect(stripProgressCardRawContentBlocks(markdown)).toBe("beforemiddleafter");
    expect(stripProgressCardRawContentBlocks("before<script>unfinished")).toBe(
      "before<script>unfinished",
    );
    expect(stripProgressCardRawContentBlocks("<script><style </script>VISIBLE</style>")).toBe(
      "VISIBLE</style>",
    );
    expect(stripProgressCardRawContentBlocks("<scriptſ>visible</script>")).toBe(
      "<scriptſ>visible</script>",
    );
    expect(stripProgressCardRawContentBlocks("<ſcript>hidden</ſcript>")).toBe("");
    expect(stripProgressCardRawContentBlocks("<script>hidden</script\f>")).toBe("");
    expect(stripProgressCardRawContentBlocks("<script </script>VISIBLE</script>")).toBe("");

    const unicodeBoundaryHtml = toSanitizedMarkdownHtml("`<scriptſ>visible</script>`", {
      progressBars: true,
    });
    const unicodeFoldHtml = toSanitizedMarkdownHtml("`<ſcript>hidden</ſcript>`", {
      progressBars: true,
    });
    const closingWhitespaceHtml = toSanitizedMarkdownHtml(
      "`before<script>hidden</script\f>after`",
      { progressBars: true },
    );
    const embeddedCloserHtml = toSanitizedMarkdownHtml(
      "`before<script </script>VISIBLE</script>after`",
      { progressBars: true },
    );

    expect(unicodeBoundaryHtml).toContain("visible");
    expect(unicodeFoldHtml).not.toContain("hidden");
    expect(closingWhitespaceHtml).not.toContain("hidden");
    expect(closingWhitespaceHtml).toContain("beforeafter");
    expect(embeddedCloserHtml).not.toContain("VISIBLE");
    expect(embeddedCloserHtml).toContain("beforeafter");
  });

  it("keeps raw-content preprocessing bounded for repeated unclosed tags", () => {
    const markdown = "<script>".repeat(17_500);
    const startedAt = performance.now();

    const preprocessed = stripProgressCardRawContentBlocks(markdown);
    const elapsedMs = performance.now() - startedAt;

    expect(preprocessed).toBe(markdown);
    expect(elapsedMs).toBeLessThan(100);
    const progressHtml = toSanitizedMarkdownHtml(markdown, { progressBars: true });
    expect(progressHtml).not.toContain("<script");
  });

  it("keeps malformed closing-tag validation bounded", () => {
    const markdown = "</script ".repeat(7_000) + " ".repeat(70_000) + ">";
    const startedAt = performance.now();

    const preprocessed = stripProgressCardRawContentBlocks(markdown);
    const elapsedMs = performance.now() - startedAt;

    expect(preprocessed).toBe(markdown);
    expect(elapsedMs).toBeLessThan(100);
    toSanitizedMarkdownHtml(markdown, { progressBars: true });
  });
});
