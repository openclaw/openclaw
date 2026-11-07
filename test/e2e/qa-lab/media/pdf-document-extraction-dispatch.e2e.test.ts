import { describe, expect, it } from "vitest";
import { extractPdfContent } from "../../../../src/media/pdf-extract.js";
import { resolvePluginDocumentExtractors } from "../../../../src/plugins/document-extractors.runtime.js";

const SENTINEL = "OPENCLAW_PDF_DISPATCH_SENTINEL";

function createInlinePdf(text: string): Buffer {
  const escapedText = text.replace(/[\\()]/gu, "\\$&");
  const content = `BT\n/F1 18 Tf\n72 720 Td\n(${escapedText}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n% OpenClaw QA fixture\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

describe("PDF document extraction dispatch", () => {
  it("uses the bundled PDF extractor and reports disabled extraction explicitly", async () => {
    const buffer = createInlinePdf(SENTINEL);
    const options = { buffer, maxPages: 1, maxPixels: 1_000_000, minTextChars: 1 };
    const bundledPdfExtractor = resolvePluginDocumentExtractors().find(
      (extractor) => extractor.id === "pdf",
    );

    expect(bundledPdfExtractor).toMatchObject({
      id: "pdf",
      pluginId: "document-extract",
      mimeTypes: ["application/pdf"],
    });

    await expect(extractPdfContent(options)).resolves.toEqual({
      text: SENTINEL,
      images: [],
      metadata: {
        pages: {
          processed: [1],
          total: 1,
          truncated: false,
          selection: "automatic",
        },
        textTruncated: false,
        imagesTruncated: false,
      },
    });

    await expect(
      extractPdfContent({
        ...options,
        config: { plugins: { entries: { "document-extract": { enabled: false } } } },
      }),
    ).rejects.toThrow(
      "PDF extraction disabled or unavailable: enable the document-extract plugin to process application/pdf files.",
    );
  });
});
