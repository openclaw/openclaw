// PDF extraction tests cover text extraction adapter selection and failures.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { extractDocumentContentMock } = vi.hoisted(() => ({
  extractDocumentContentMock: vi.fn(),
}));

vi.mock("./document-extractors.runtime.js", () => ({
  extractDocumentContent: extractDocumentContentMock,
}));

import { extractPdfContent } from "./pdf-extract.js";

describe("extractPdfContent", () => {
  beforeEach(() => {
    extractDocumentContentMock.mockReset();
  });

  it("dispatches PDF extraction and preserves completeness metadata", async () => {
    const metadata = {
      pages: {
        processed: [1, 2],
        total: 3,
        selection: "automatic" as const,
        truncated: true,
      },
      textTruncated: true,
      imagesTruncated: false,
    };
    extractDocumentContentMock.mockResolvedValue({
      text: "extracted pdf",
      images: [],
      extractor: "pdf",
      metadata,
    });

    await expect(
      extractPdfContent({
        buffer: Buffer.from("%PDF-1.4"),
        maxPages: 2,
        maxPixels: 100,
        minTextChars: 10,
        password: "synthetic-password",
      }),
    ).resolves.toEqual({ text: "extracted pdf", images: [], metadata });
    expect(extractDocumentContentMock).toHaveBeenCalledWith({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
      password: "synthetic-password",
    });
  });

  it("throws a clear disabled error when no document extractor is available", async () => {
    extractDocumentContentMock.mockResolvedValue(null);

    await expect(
      extractPdfContent({
        buffer: Buffer.from("%PDF-1.4"),
        maxPages: 2,
        maxPixels: 100,
        minTextChars: 10,
      }),
    ).rejects.toThrow("PDF extraction disabled or unavailable");
  });
});
