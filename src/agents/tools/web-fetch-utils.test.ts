import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./web-fetch-utils.js";

describe("htmlToMarkdown JSON-LD extraction (#17137)", () => {
  it("preserves JSON-LD blocks that would otherwise be stripped with scripts", () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Test"}</script>
      <script>console.log("removed")</script>
    </head><body><p>Hello world</p></body></html>`;
    const { text } = htmlToMarkdown(html);
    expect(text).toContain("Structured Data (JSON-LD)");
    expect(text).toContain('"@type":"Article"');
    expect(text).not.toContain("console.log");
  });

  it("handles multiple JSON-LD blocks", () => {
    const html = `<html><body>
      <script type="application/ld+json">{"@type":"Organization"}</script>
      <script type="application/ld+json">{"@type":"WebSite"}</script>
      <p>Content</p>
    </body></html>`;
    const { text } = htmlToMarkdown(html);
    expect(text).toContain('"@type":"Organization"');
    expect(text).toContain('"@type":"WebSite"');
  });

  it("returns normal markdown when no JSON-LD is present", () => {
    const html = `<html><body><p>No structured data</p></body></html>`;
    const { text } = htmlToMarkdown(html);
    expect(text).not.toContain("Structured Data");
    expect(text).toContain("No structured data");
  });
});
