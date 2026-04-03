import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type CanvasModule = typeof import("@napi-rs/canvas");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

const execFile = promisify(execFileCallback);
const DEFAULT_NUTRIENT_COMMAND = "pdf-to-markdown";
const DEFAULT_NUTRIENT_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const STDERR_SNIPPET_MAX_CHARS = 300;

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
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
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
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

export type PdfExtractionConfiguredEngine = "auto" | "nutrient" | "pdfjs";
export type PdfExtractionResolvedEngine = "nutrient" | "pdfjs";

export type PdfExtractionMeta = {
  engineConfigured: PdfExtractionConfiguredEngine;
  engineUsed: PdfExtractionResolvedEngine;
  engineFallback: boolean;
  fallbackReason?: string;
  durationMs: number;
  chars: number;
  empty: boolean;
  pageCountProcessed?: number;
  pageCountTotal?: number;
  imageCount: number;
  stderrSnippet?: string;
};

export type PdfExtractedContent = {
  text: string;
  images: PdfExtractedImage[];
  meta?: PdfExtractionMeta;
};

export type PdfExtractionRequest = {
  buffer: Buffer;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
  engine?: PdfExtractionConfiguredEngine;
  fallbackOnError?: boolean;
  nutrientCommand?: string;
  nutrientTimeoutMs?: number;
};

class PdfExtractionEngineError extends Error {
  readonly code: string;
  readonly stderrSnippet?: string;

  constructor(code: string, message: string, stderrSnippet?: string) {
    super(message);
    this.name = "PdfExtractionEngineError";
    this.code = code;
    this.stderrSnippet = stderrSnippet;
  }
}

function coerceStderrSnippet(stderr: unknown): string | undefined {
  if (typeof stderr !== "string") {
    return undefined;
  }
  const trimmed = stderr.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, STDERR_SNIPPET_MAX_CHARS);
}

function buildMeta(params: {
  engineConfigured: PdfExtractionConfiguredEngine;
  engineUsed: PdfExtractionResolvedEngine;
  engineFallback?: boolean;
  fallbackReason?: string;
  durationMs: number;
  text: string;
  pageCountProcessed?: number;
  pageCountTotal?: number;
  imageCount: number;
  stderrSnippet?: string;
}): PdfExtractionMeta {
  return {
    engineConfigured: params.engineConfigured,
    engineUsed: params.engineUsed,
    engineFallback: params.engineFallback === true,
    ...(params.fallbackReason ? { fallbackReason: params.fallbackReason } : {}),
    durationMs: params.durationMs,
    chars: params.text.trim().length,
    empty: params.text.trim().length === 0,
    ...(typeof params.pageCountProcessed === "number"
      ? { pageCountProcessed: params.pageCountProcessed }
      : {}),
    ...(typeof params.pageCountTotal === "number" ? { pageCountTotal: params.pageCountTotal } : {}),
    imageCount: params.imageCount,
    ...(params.stderrSnippet ? { stderrSnippet: params.stderrSnippet } : {}),
  };
}

function toFallbackReason(error: unknown): string {
  if (error instanceof PdfExtractionEngineError) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

export async function extractPdfContentPdfJs(
  params: PdfExtractionRequest & {
    engineConfigured?: PdfExtractionConfiguredEngine;
    engineFallback?: boolean;
    fallbackReason?: string;
  },
): Promise<PdfExtractedContent> {
  const startedAt = Date.now();
  const {
    buffer,
    maxPages,
    maxPixels,
    minTextChars,
    pageNumbers,
    onImageExtractionError,
    engineConfigured = "pdfjs",
    engineFallback = false,
    fallbackReason,
  } = params;
  const { getDocument } = await loadPdfJsModule();
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;

  const effectivePages: number[] = pageNumbers
    ? pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, maxPages)
    : Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => i + 1);

  const textParts: string[] = [];
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      textParts.push(pageText);
    }
  }

  const text = textParts.join("\n\n");
  if (text.trim().length >= minTextChars) {
    return {
      text,
      images: [],
      meta: buildMeta({
        engineConfigured,
        engineUsed: "pdfjs",
        engineFallback,
        fallbackReason,
        durationMs: Date.now() - startedAt,
        text,
        pageCountProcessed: effectivePages.length,
        pageCountTotal: pdf.numPages,
        imageCount: 0,
      }),
    };
  }

  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch (err) {
    onImageExtractionError?.(err);
    return {
      text,
      images: [],
      meta: buildMeta({
        engineConfigured,
        engineUsed: "pdfjs",
        engineFallback,
        fallbackReason,
        durationMs: Date.now() - startedAt,
        text,
        pageCountProcessed: effectivePages.length,
        pageCountTotal: pdf.numPages,
        imageCount: 0,
      }),
    };
  }

  const { createCanvas } = canvasModule;
  const images: PdfExtractedImage[] = [];
  const pixelBudget = Math.max(1, maxPixels);

  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pagePixels = viewport.width * viewport.height;
    const scale = Math.min(1, Math.sqrt(pixelBudget / Math.max(1, pagePixels)));
    const scaled = page.getViewport({ scale: Math.max(0.1, scale) });
    const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }

  return {
    text,
    images,
    meta: buildMeta({
      engineConfigured,
      engineUsed: "pdfjs",
      engineFallback,
      fallbackReason,
      durationMs: Date.now() - startedAt,
      text,
      pageCountProcessed: effectivePages.length,
      pageCountTotal: pdf.numPages,
      imageCount: images.length,
    }),
  };
}

export async function extractPdfContentNutrient(
  params: PdfExtractionRequest & { engineConfigured?: PdfExtractionConfiguredEngine },
): Promise<PdfExtractedContent> {
  const startedAt = Date.now();
  const {
    buffer,
    pageNumbers,
    nutrientCommand = DEFAULT_NUTRIENT_COMMAND,
    nutrientTimeoutMs = DEFAULT_NUTRIENT_TIMEOUT_MS,
    engineConfigured = "nutrient",
  } = params;

  if (pageNumbers && pageNumbers.length > 0) {
    throw new PdfExtractionEngineError(
      "unsupported_pages",
      "Nutrient PDF extraction does not support page filtering yet.",
    );
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-markdown-"));
  const inputPath = path.join(tmpDir, "input.pdf");

  try {
    await writeFile(inputPath, buffer);
    const { stdout, stderr } = await execFile(nutrientCommand, [inputPath], {
      timeout: nutrientTimeoutMs,
      maxBuffer: DEFAULT_EXEC_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    const text = stdout.trim();
    const stderrSnippet = coerceStderrSnippet(stderr);
    return {
      text,
      images: [],
      meta: buildMeta({
        engineConfigured,
        engineUsed: "nutrient",
        durationMs: Date.now() - startedAt,
        text,
        imageCount: 0,
        stderrSnippet,
      }),
    };
  } catch (error) {
    const stderrSnippet = coerceStderrSnippet(
      error && typeof error === "object" && "stderr" in error ? error.stderr : undefined,
    );
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new PdfExtractionEngineError(
        "cli_missing",
        `Nutrient extractor command not found: ${nutrientCommand}`,
        stderrSnippet,
      );
    }
    if (error && typeof error === "object" && "killed" in error && error.killed === true) {
      throw new PdfExtractionEngineError(
        "timeout",
        `Nutrient extractor timed out after ${nutrientTimeoutMs}ms.`,
        stderrSnippet,
      );
    }
    if (error instanceof Error) {
      throw new PdfExtractionEngineError(
        "cli_failed",
        `Nutrient extractor failed: ${error.message}`,
        stderrSnippet,
      );
    }
    throw new PdfExtractionEngineError(
      "cli_failed",
      `Nutrient extractor failed: ${String(error)}`,
      stderrSnippet,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function extractPdfContent(
  params: PdfExtractionRequest,
): Promise<PdfExtractedContent> {
  const engineConfigured = params.engine ?? "pdfjs";
  const fallbackOnError = params.fallbackOnError ?? true;

  if (engineConfigured === "pdfjs") {
    return extractPdfContentPdfJs({ ...params, engineConfigured });
  }

  if (engineConfigured === "auto" && params.pageNumbers && params.pageNumbers.length > 0) {
    return extractPdfContentPdfJs({ ...params, engineConfigured });
  }

  try {
    return await extractPdfContentNutrient({ ...params, engineConfigured });
  } catch (error) {
    if (!fallbackOnError) {
      throw error;
    }
    return extractPdfContentPdfJs({
      ...params,
      engineConfigured,
      engineFallback: true,
      fallbackReason: toFallbackReason(error),
    });
  }
}
