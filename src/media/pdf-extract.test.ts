import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

import { extractPdfContent } from "./pdf-extract.js";

function createSimplePdfBuffer(text = "Hello Nutrient PDF"): Buffer {
  const sanitized = text.replace(/[()\\]/g, " ");
  const content = `BT /F1 24 Tf 72 96 Td (${sanitized}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(content, "utf8")} >> stream\n${content}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

describe("extractPdfContent engine routing", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    execFileMock.mockReset();
    vi.restoreAllMocks();
  });

  it("routes auto+pages requests to pdfjs without invoking Nutrient", async () => {
    const result = await extractPdfContent({
      buffer: createSimplePdfBuffer("Auto Page Filter"),
      maxPages: 5,
      maxPixels: 1_000_000,
      minTextChars: 1,
      engine: "auto",
      pageNumbers: [1],
    });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.text).toContain("Auto Page Filter");
    expect(result.images).toEqual([]);
    expect(result.meta).toMatchObject({
      engineConfigured: "auto",
      engineUsed: "pdfjs",
      engineFallback: false,
      pageCountProcessed: 1,
      pageCountTotal: 1,
    });
  });

  it("uses Nutrient output when configured and the CLI succeeds", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: "# Nutrient Markdown\n\nConverted.", stderr: "warning: none" });
      },
    );

    const result = await extractPdfContent({
      buffer: createSimplePdfBuffer(),
      maxPages: 5,
      maxPixels: 1_000_000,
      minTextChars: 1,
      engine: "nutrient",
      fallbackOnError: true,
      nutrientCommand: "pdf-to-markdown",
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "# Nutrient Markdown\n\nConverted.",
      images: [],
      meta: {
        engineConfigured: "nutrient",
        engineUsed: "nutrient",
        engineFallback: false,
        imageCount: 0,
        stderrSnippet: "warning: none",
      },
    });
  });

  it("falls back to pdfjs when Nutrient is unavailable and fallback is enabled", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (
          error: NodeJS.ErrnoException | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const error = Object.assign(new Error("spawn pdf-to-markdown ENOENT"), {
          code: "ENOENT",
        }) as NodeJS.ErrnoException;
        callback(error);
      },
    );

    const result = await extractPdfContent({
      buffer: createSimplePdfBuffer("Fallback Text"),
      maxPages: 5,
      maxPixels: 1_000_000,
      minTextChars: 1,
      engine: "nutrient",
      fallbackOnError: true,
      nutrientCommand: "pdf-to-markdown",
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("Fallback Text");
    expect(result.meta).toMatchObject({
      engineConfigured: "nutrient",
      engineUsed: "pdfjs",
      engineFallback: true,
      fallbackReason: "Nutrient extractor command not found: pdf-to-markdown",
    });
  });

  it("surfaces Nutrient failures when fallback is disabled", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        callback(new Error("converter exploded"));
      },
    );

    await expect(
      extractPdfContent({
        buffer: createSimplePdfBuffer(),
        maxPages: 5,
        maxPixels: 1_000_000,
        minTextChars: 1,
        engine: "nutrient",
        fallbackOnError: false,
        nutrientCommand: "pdf-to-markdown",
      }),
    ).rejects.toThrow("Nutrient extractor failed: converter exploded");
  });
});
