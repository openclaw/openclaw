import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";

type CanvasLike = {
  toBuffer(type: "image/png"): Buffer;
};

type CanvasModule = {
  createCanvas(width: number, height: number): CanvasLike;
};

type PdfTextItem = {
  str: string;
};

type PdfTextContent = {
  items: Array<PdfTextItem | object>;
};

type PdfViewport = {
  width: number;
  height: number;
};

type PdfPage = {
  getTextContent(): Promise<PdfTextContent>;
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvas: unknown; viewport: PdfViewport }): { promise: Promise<void> };
};

type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

type PdfJsModule = {
  getDocument(params: {
    data: Uint8Array;
    disableWorker?: boolean;
    standardFontDataUrl?: string;
  }): {
    promise: Promise<PdfDocument>;
  };
};

const CANVAS_MODULE = "@napi-rs/canvas";
const PDFJS_MODULE = "pdfjs-dist/legacy/build/pdf.mjs";

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let standardFontDataPathCache: string | null = null;

// pdf.js dynamically imports pdf.worker.mjs during `getDocument()`. Even with
// `disableWorker: true`, the worker module initialization can throw an
// unhandled rejection (`BaseExceptionClosure` at module top-level). This
// rejection is asynchronous and escapes all try-catch boundaries at the call
// site. Without suppression, it reaches the gateway's unhandled-rejection
// handler, which calls `process.exit(1)` and crashes the entire gateway.
//
// Register a handler through OpenClaw's own unhandled-rejection system so the
// pdfjs worker error is marked as handled before the crash handler sees it.
//
// The check is intentionally narrow: we require the stack to contain both the
// pdf.worker.mjs module path AND the `ModuleJob.run` frame that indicates this
// is the known top-level worker initialization error, not a runtime failure
// from an actual pdf.js operation.
registerUnhandledRejectionHandler((reason: unknown): boolean => {
  const err = reason as { message?: string; stack?: string } | undefined;
  const stack = err?.stack ?? "";
  return stack.includes("pdf.worker") && stack.includes("ModuleJob.run");
});

// pdf.js needs `standardFontDataUrl` to render PDFs that reference the 14
// standard PDF fonts (Helvetica, Times, Courier, etc.). Without it, every such
// document throws `UnknownErrorException: Ensure that the standardFontDataUrl
// API parameter is provided`, which then yields empty/garbled text extraction.
//
// The font files ship inside `pdfjs-dist/standard_fonts/`, so we resolve that
// directory through the actual module resolver (works regardless of bundling).
//
// IMPORTANT: pdf.js's Node-side font fetcher reads via `fs.promises.readFile`
// and expects a plain filesystem path with a trailing separator — not a
// `file://` URL. Passing a `file://` URL triggers
// `Unable to load font data at: file:///...` warnings even though the file
// exists. This module is server-side only (the gateway runs in Node), so we
// always pass a filesystem path.
function getStandardFontDataPath(): string | undefined {
  if (standardFontDataPathCache !== null) {
    return standardFontDataPathCache || undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    const fontDir = join(dirname(pkgPath), "standard_fonts") + sep;
    standardFontDataPathCache = fontDir;
    return standardFontDataPathCache;
  } catch {
    standardFontDataPathCache = "";
    return undefined;
  }
}

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = (import(CANVAS_MODULE) as Promise<CanvasModule>).catch((err) => {
      canvasModulePromise = null;
      throw new Error(
        `Optional dependency @napi-rs/canvas is required for PDF image extraction: ${String(err)}`,
      );
    });
  }
  return canvasModulePromise;
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = (import(PDFJS_MODULE) as Promise<PdfJsModule>).catch((err) => {
      pdfJsModulePromise = null;
      throw new Error(
        `Optional dependency pdfjs-dist is required for PDF extraction: ${String(err)}`,
      );
    });
  }
  return pdfJsModulePromise;
}

export type PdfExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PdfExtractedContent = {
  text: string;
  images: PdfExtractedImage[];
};

export async function extractPdfContent(params: {
  buffer: Buffer;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent> {
  const { buffer, maxPages, maxPixels, minTextChars, pageNumbers, onImageExtractionError } = params;
  const pdfJsModule = await loadPdfJsModule();
  const pdf = await pdfJsModule.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    standardFontDataUrl: getStandardFontDataPath(),
  }).promise;

  const effectivePages: number[] = pageNumbers
    ? pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, maxPages)
    : Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => i + 1);

  const textParts: string[] = [];
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      textParts.push(pageText);
    }
  }

  const text = textParts.join("\n\n");
  if (text.trim().length >= minTextChars) {
    return { text, images: [] };
  }

  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch (err) {
    onImageExtractionError?.(err);
    return { text, images: [] };
  }

  const images: PdfExtractedImage[] = [];
  const pixelBudget = Math.max(1, maxPixels);

  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pagePixels = viewport.width * viewport.height;
    const scale = Math.min(1, Math.sqrt(pixelBudget / Math.max(1, pagePixels)));
    const scaled = page.getViewport({ scale: Math.max(0.1, scale) });
    const canvas = canvasModule.createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }

  return { text, images };
}
