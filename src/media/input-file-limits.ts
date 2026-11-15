import { normalizeMimeType } from "@openclaw/media-core/mime";

type InputPdfLimits = {
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
};

type InputSourceLimits = {
  allowUrl: boolean;
  urlAllowlist?: string[];
  allowedMimes: Set<string>;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
};

export type InputFileLimits = InputSourceLimits & { maxChars: number; pdf: InputPdfLimits };

export type InputFileLimitsConfig = Partial<
  Omit<InputFileLimits, "allowedMimes" | "pdf" | "urlAllowlist">
> & {
  allowedMimes?: string[];
  pdf?: Partial<InputPdfLimits>;
};

export type InputImageLimits = InputSourceLimits;

export const DEFAULT_INPUT_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
];
const DEFAULT_INPUT_FILE_MIMES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
];
export const DEFAULT_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_INPUT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_INPUT_FILE_MAX_CHARS = 60_000;
export const DEFAULT_INPUT_MAX_REDIRECTS = 3;
export const DEFAULT_INPUT_TIMEOUT_MS = 10_000;
const DEFAULT_INPUT_PDF_MAX_PAGES = 4;
const DEFAULT_INPUT_PDF_MAX_PIXELS = 4_000_000;
/** Default text threshold before PDF extraction keeps text-only output. */
const DEFAULT_INPUT_PDF_MIN_TEXT_CHARS = 200;

/** Converts configured MIME lists into a normalized allowlist, using fallback defaults when empty. */
export function normalizeMimeList(values: string[] | undefined, fallback: string[]): Set<string> {
  const input = values && values.length > 0 ? values : fallback;
  return new Set(input.flatMap((value) => normalizeMimeType(value) ?? []));
}

export function resolveInputFileLimits(config?: InputFileLimitsConfig): InputFileLimits {
  return {
    allowUrl: config?.allowUrl ?? true,
    allowedMimes: normalizeMimeList(config?.allowedMimes, DEFAULT_INPUT_FILE_MIMES),
    maxBytes: config?.maxBytes ?? DEFAULT_INPUT_FILE_MAX_BYTES,
    maxChars: config?.maxChars ?? DEFAULT_INPUT_FILE_MAX_CHARS,
    maxRedirects: config?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
    timeoutMs: config?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    pdf: {
      maxPages: config?.pdf?.maxPages ?? DEFAULT_INPUT_PDF_MAX_PAGES,
      maxPixels: config?.pdf?.maxPixels ?? DEFAULT_INPUT_PDF_MAX_PIXELS,
      minTextChars: config?.pdf?.minTextChars ?? DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
    },
  };
}
