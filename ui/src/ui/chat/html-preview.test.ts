import { describe, expect, it } from "vitest";
import {
  buildHtmlPreviewSrcdoc,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  detectHtmlDocumentPreview,
} from "./html-preview.ts";

const HTML_PREVIEW_LIMIT = 750_000;
const HTML_PREVIEW_TRUNCATION_COMMENT = `\n<!-- OpenClaw: HTML preview truncated at ${HTML_PREVIEW_LIMIT} characters. -->`;
const HTML_PREVIEW_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

function createHtmlDocumentWithLength(length: number): string {
  const prefix = "<html><body>";
  const suffix = "</body></html>";
  const fillerLength = length - prefix.length - suffix.length;
  if (fillerLength < 0) {
    throw new Error(`Cannot create an HTML document with only ${length} characters.`);
  }
  return `${prefix}${"x".repeat(fillerLength)}${suffix}`;
}

describe("detectHtmlDocumentPreview", () => {
  it("detects complete HTML documents", () => {
    const result = detectHtmlDocumentPreview(
      '<html><head><style>body{font-family:Arial}</style></head><body><img src="data:image/svg+xml;base64,PHN2Zy8+"></body></html>',
    );
    expect(result?.truncated).toBe(false);
    expect(result?.html).toContain("<body>");
  });

  it.each(["html", "htm"] as const)(
    "detects whole-message %s fenced HTML documents",
    (language) => {
      const result = detectHtmlDocumentPreview(
        `\`\`\`${language}\n<!doctype html><html><body><h1>Report</h1></body></html>\n\`\`\``,
      );
      expect(result?.html).toBe("<!doctype html><html><body><h1>Report</h1></body></html>");
    },
  );

  it("detects whole-message fenced HTML documents with CRLF line endings", () => {
    const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
    const result = detectHtmlDocumentPreview(`\`\`\`html\r\n${html}\r\n\`\`\``);
    expect(result?.html).toBe(html);
  });

  it("preserves fenced HTML document content", () => {
    const html = "\n<!doctype html><html><body>\n  <h1>Report</h1>\n</body></html>\n";
    const result = detectHtmlDocumentPreview(`\`\`\`html\n${html}\n\`\`\``);
    expect(result?.html).toBe(html);
  });

  it("detects paired head and body documents", () => {
    const result = detectHtmlDocumentPreview(
      "<head><title>Report</title></head>\n\n<body><h1>Report</h1></body>",
    );
    expect(result?.html).toContain("<head>");
    expect(result?.html).toContain("<body>");
  });

  it("does not strip or preview non-whole-message HTML fences", () => {
    expect(
      detectHtmlDocumentPreview(
        "Before\n```html\n<!doctype html><html><body><h1>Report</h1></body></html>\n```",
      ),
    ).toBeNull();
    expect(
      detectHtmlDocumentPreview(
        "```html\n<!doctype html><html><body><h1>Report</h1></body></html>\n```\nAfter",
      ),
    ).toBeNull();
  });

  it("does not truncate documents at the preview limit", () => {
    const html = createHtmlDocumentWithLength(HTML_PREVIEW_LIMIT);
    const result = detectHtmlDocumentPreview(html);
    expect(result).toEqual({ html, truncated: false });
  });

  it("truncates documents over the preview limit", () => {
    const html = createHtmlDocumentWithLength(HTML_PREVIEW_LIMIT + 1);
    const result = detectHtmlDocumentPreview(html);
    expect(result?.truncated).toBe(true);
    expect(result?.html).toContain(HTML_PREVIEW_TRUNCATION_COMMENT.trim());
    expect(result?.html).toBe(
      `${html.slice(0, HTML_PREVIEW_LIMIT)}${HTML_PREVIEW_TRUNCATION_COMMENT}`,
    );
    expect(result?.html).toHaveLength(HTML_PREVIEW_LIMIT + HTML_PREVIEW_TRUNCATION_COMMENT.length);
  });

  it("does not treat small raw HTML snippets as full documents", () => {
    expect(detectHtmlDocumentPreview("<strong>Important</strong>")).toBeNull();
    expect(detectHtmlDocumentPreview("Use <html> literally in docs.")).toBeNull();
    expect(detectHtmlDocumentPreview("Example: <html><body>x</body></html> done")).toBeNull();
    expect(detectHtmlDocumentPreview("Example: <head></head><body>x</body> done")).toBeNull();
    expect(detectHtmlDocumentPreview("<html> is the root element...")).toBeNull();
    expect(detectHtmlDocumentPreview("<html><body>x")).toBeNull();
    expect(detectHtmlDocumentPreview("<!doctype html>")).toBeNull();
  });

  it("uses a scriptless sandbox policy for previews", () => {
    expect(HTML_PREVIEW_SANDBOX).toBe("");
    expect(HTML_PREVIEW_CSP).toBe(
      "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'",
    );
    expect(HTML_PREVIEW_CSP).not.toContain("script-src");
  });

  it("injects CSP metadata into preview srcdoc documents", () => {
    expect(
      buildHtmlPreviewSrcdoc("<html><head><title>Report</title></head><body></body></html>"),
    ).toBe(`<html><head>${HTML_PREVIEW_CSP_META}<title>Report</title></head><body></body></html>`);

    expect(buildHtmlPreviewSrcdoc("<html><body><h1>Report</h1></body></html>")).toBe(
      `<html><head>${HTML_PREVIEW_CSP_META}</head><body><h1>Report</h1></body></html>`,
    );

    expect(buildHtmlPreviewSrcdoc("<head></head><body><h1>Report</h1></body>")).toBe(
      `<head>${HTML_PREVIEW_CSP_META}</head><body><h1>Report</h1></body>`,
    );
  });

  it("does not inject CSP metadata into commented head markers", () => {
    expect(
      buildHtmlPreviewSrcdoc(
        '<!doctype html><html><!-- <head> marker --><body><img src="https://example.test/leak.png"></body></html>',
      ),
    ).toBe(
      `<!doctype html><html><head>${HTML_PREVIEW_CSP_META}</head><!-- <head> marker --><body><img src="https://example.test/leak.png"></body></html>`,
    );

    expect(
      buildHtmlPreviewSrcdoc(
        "<html><!-- leading comment --><head><title>Report</title></head><body></body></html>",
      ),
    ).toBe(
      `<html><!-- leading comment --><head>${HTML_PREVIEW_CSP_META}<title>Report</title></head><body></body></html>`,
    );
  });

  it("does not inject CSP metadata into script head markers", () => {
    expect(
      buildHtmlPreviewSrcdoc(
        '<html><script>const marker = "<head>";</script><body><img src="https://example.test/script-head.png"></body></html>',
      ),
    ).toBe(
      `<html><head>${HTML_PREVIEW_CSP_META}</head><script>const marker = "<head>";</script><body><img src="https://example.test/script-head.png"></body></html>`,
    );
  });
});
