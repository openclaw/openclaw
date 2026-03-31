import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocumentMock = vi.fn();
const createCanvasMock = vi.fn(() => ({
  toBuffer: vi.fn(() => Buffer.from("png")),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: getDocumentMock,
}));

vi.mock("@napi-rs/canvas", () => ({
  createCanvas: createCanvasMock,
}));

import { extractPdfContent } from "./pdf-extract.js";

describe("extractPdfContent standard font wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const renderMock = vi.fn(() => ({ promise: Promise.resolve() }));
    const getViewportMock = vi.fn(({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: 100 * scale,
    }));
    const getTextContentMock = vi.fn(async () => ({ items: [] }));
    const getPageMock = vi.fn(async () => ({
      getTextContent: getTextContentMock,
      getViewport: getViewportMock,
      render: renderMock,
    }));

    getDocumentMock.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: getPageMock,
        destroy: vi.fn(async () => undefined),
      }),
    });
  });

  it("passes standardFontDataUrl to pdfjs getDocument on fallback render path", async () => {
    await extractPdfContent({
      buffer: Buffer.from("fake pdf"),
      maxPages: 1,
      maxPixels: 4_000_000,
      minTextChars: 200,
    });

    expect(getDocumentMock).toHaveBeenCalledTimes(1);
    const [params] = getDocumentMock.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      disableWorker: true,
    });
    expect(typeof params.standardFontDataUrl).toBe("string");
    const normalizedStandardFontDataUrl = params.standardFontDataUrl.replace(/\\/g, "/");
    expect(normalizedStandardFontDataUrl).toContain("standard_fonts");
    expect(normalizedStandardFontDataUrl.endsWith("standard_fonts/")).toBe(true);
    expect(existsSync(params.standardFontDataUrl)).toBe(true);
    expect(createCanvasMock).toHaveBeenCalledTimes(1);
  });
});
