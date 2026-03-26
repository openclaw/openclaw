import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("extractPdfContent", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.restoreAllMocks();
  });

  it("passes a filesystem standard font path to getDocument", async () => {
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: vi.fn().mockResolvedValue({
          getTextContent: vi.fn().mockResolvedValue({
            items: [{ str: "hello from pdf" }],
          }),
        }),
      }),
    }));

    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument,
    }));

    const { extractPdfContent } = await import("./pdf-extract.js");

    const result = await extractPdfContent({
      buffer: Buffer.from("%PDF-1.7"),
      maxPages: 1,
      maxPixels: 1024,
      minTextChars: 1,
    });

    expect(result).toEqual({ text: "hello from pdf", images: [] });
    expect(getDocument).toHaveBeenCalledTimes(1);
    const params = getDocument.mock.lastCall?.at(0) as
      | {
          data: Uint8Array;
          disableWorker: boolean;
          standardFontDataUrl?: string;
        }
      | undefined;
    expect(params).toBeDefined();
    expect(params).toEqual(
      expect.objectContaining({
        data: expect.any(Uint8Array),
        disableWorker: true,
      }),
    );
    expect(params?.standardFontDataUrl).toContain("/pdfjs-dist/standard_fonts/");
    expect(params?.standardFontDataUrl).toMatch(/\/$/);
    expect(params?.standardFontDataUrl).not.toMatch(/^file:\/\//);
  });
});
