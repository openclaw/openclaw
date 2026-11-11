import { MIMEType } from "node:util";
import {
  classifyAttachmentBytes,
  type AttachmentClassification,
} from "@openclaw/media-core/attachment-classify";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { parseMediaContentLength } from "@openclaw/media-core/content-length";
import { detectMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { logWarn } from "../logger.js";
import type { DocumentExtractionMetadata } from "../plugins/document-extractor-types.js";
import type { InputFileLimits, InputImageLimits } from "./input-file-limits.js";
import { convertHeicToJpeg, convertImageToJpeg } from "./media-services.js";
import { extractPdfContent, type PdfExtractedImage } from "./pdf-extract.js";

type InputFileExtractResult = {
  filename: string;
  text?: string;
  images?: PdfExtractedImage[];
  metadata?: DocumentExtractionMetadata;
};

export type InputImageSource =
  | {
      type: "base64";
      data: string;
      mediaType?: string;
    }
  | {
      type: "url";
      url: string;
      mediaType?: string;
    };

type InputFileSource = InputImageSource & { filename?: string };

type InputFetchResult = {
  buffer: Buffer;
  contentType?: string;
};

const NORMALIZED_INPUT_IMAGE_MIME = "image/jpeg";
const CONVERTIBLE_INPUT_IMAGE_MIMES = new Set(["image/avif", "image/heic", "image/heif"]);

function parseContentType(value: string | undefined): {
  mimeType?: string;
  charset?: string;
} {
  if (!value) {
    return {};
  }
  const mimeType = normalizeMimeType(value);
  try {
    return { mimeType, charset: new MIMEType(value).params.get("charset") ?? undefined };
  } catch {
    // Invalid metadata still goes through byte classification and MIME allowlists.
    return { mimeType };
  }
}

async function readInputSource(
  source: InputImageSource,
  limits: InputImageLimits,
  kind: "input_image" | "input_file",
  signal?: AbortSignal,
): Promise<InputFetchResult & { canonicalData?: string }> {
  if (source.type === "base64") {
    const estimated = estimateBase64DecodedBytes(source.data);
    if (estimated > limits.maxBytes) {
      const label = kind === "input_image" ? "Image" : "File";
      throw new Error(`${label} too large: ${estimated} bytes (limit: ${limits.maxBytes} bytes)`);
    }
    const canonicalData = canonicalizeBase64(source.data);
    if (!canonicalData) {
      throw new Error(`${kind} base64 source has invalid 'data' field`);
    }
    return {
      buffer: Buffer.from(canonicalData, "base64"),
      contentType: source.mediaType,
      canonicalData,
    };
  }
  if (kind === "input_image" && source.type !== "url") {
    throw new Error(`Unsupported input_image source type: ${(source as { type: string }).type}`);
  }
  if (!limits.allowUrl) {
    throw new Error(`${kind} URL sources are disabled by config`);
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: source.url,
    maxRedirects: limits.maxRedirects,
    timeoutMs: limits.timeoutMs,
    signal,
    policy: { allowPrivateNetwork: false, hostnameAllowlist: limits.urlAllowlist },
    auditContext: `openresponses.${kind}`,
    init: { headers: { "User-Agent": "OpenClaw-Gateway/1.0" } },
  });

  let result: InputFetchResult;
  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    let contentLength: number | null;
    try {
      contentLength = parseMediaContentLength(response.headers.get("content-length"));
    } catch (err) {
      await cancelUnreadResponseBody(response);
      throw err;
    }
    if (contentLength !== null && contentLength > limits.maxBytes) {
      await cancelUnreadResponseBody(response);
      throw new Error(
        `Content too large: ${contentLength} bytes (limit: ${limits.maxBytes} bytes)`,
      );
    }

    const buffer = await readResponseWithLimit(response, limits.maxBytes);

    const contentType = response.headers.get("content-type") ?? undefined;
    result = { buffer, contentType };
  } finally {
    await release();
  }
  // Successful downloads can finish transport cleanup after their caller canceled.
  signal?.throwIfAborted();
  return result;
}

function decodeTextContent(buffer: Buffer, charset: string | undefined, maxChars: number) {
  const encoding = normalizeOptionalLowercaseString(charset) || "utf-8";
  const limit = Math.max(0, Math.floor(maxChars));
  const decode = (label: string) => {
    const decoder = new TextDecoder(label);
    let text = "";
    // Look past an exact limit: unread bytes may only contain decoder state, not omitted text.
    for (let offset = 0; offset < buffer.length && text.length <= limit; offset += 16_384) {
      const end = Math.min(offset + 16_384, buffer.length);
      // Preserve charset state across chunks; only actual EOF flushes incomplete bytes.
      text += decoder.decode(buffer.subarray(offset, end), { stream: end < buffer.length });
    }
    const prefix = truncateUtf16Safe(text, limit);
    return {
      text: prefix,
      ...(prefix.length < text.length
        ? { metadata: { textTruncated: true, imagesTruncated: false } }
        : {}),
    };
  };
  try {
    return decode(encoding);
  } catch {
    return decode("utf-8");
  }
}

/** Validates image bytes and converts AVIF/HEIC/HEIF to JPEG, keeping the original Buffer otherwise. */
export async function normalizeInputImageBuffer(params: {
  buffer: Buffer;
  mimeType?: string;
  limits: Pick<InputImageLimits, "allowedMimes" | "maxBytes">;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  if (params.buffer.byteLength > params.limits.maxBytes) {
    throw new Error(
      `Image too large: ${params.buffer.byteLength} bytes (limit: ${params.limits.maxBytes} bytes)`,
    );
  }
  const declaredMime = normalizeMimeType(params.mimeType) ?? "application/octet-stream";
  const detectedMime = normalizeMimeType(
    await detectMime({ buffer: params.buffer, headerMime: params.mimeType }),
  );
  if (declaredMime.startsWith("image/") && detectedMime && !detectedMime.startsWith("image/")) {
    throw new Error(`Unsupported image MIME type: ${detectedMime}`);
  }
  const sourceMime = (detectedMime?.startsWith("image/") ? detectedMime : declaredMime).replace(
    /^(image\/hei[cf])-sequence$/,
    "$1",
  );
  if (!params.limits.allowedMimes.has(sourceMime)) {
    throw new Error(`Unsupported image MIME type: ${sourceMime}`);
  }

  if (!CONVERTIBLE_INPUT_IMAGE_MIMES.has(sourceMime)) {
    return { buffer: params.buffer, mimeType: sourceMime };
  }

  // Normalize AVIF/HEIC/HEIF to JPEG because downstream model and channel surfaces expect common images.
  const normalizedBuffer =
    sourceMime === "image/avif"
      ? await convertImageToJpeg(params.buffer)
      : await convertHeicToJpeg(params.buffer);
  if (normalizedBuffer.byteLength > params.limits.maxBytes) {
    throw new Error(
      `Image too large after ${sourceMime} conversion: ${normalizedBuffer.byteLength} bytes (limit: ${params.limits.maxBytes} bytes)`,
    );
  }
  return { buffer: normalizedBuffer, mimeType: NORMALIZED_INPUT_IMAGE_MIME };
}

export async function extractImageContentFromSource(
  source: InputImageSource,
  limits: InputImageLimits,
  signal?: AbortSignal,
): Promise<PdfExtractedImage> {
  signal?.throwIfAborted();
  const { buffer, contentType, canonicalData } = await readInputSource(
    source,
    limits,
    "input_image",
    signal,
  );
  const mimeType =
    source.type === "base64"
      ? (normalizeMimeType(contentType) ?? "image/png")
      : parseContentType(contentType).mimeType;
  const image = await normalizeInputImageBuffer({ buffer, mimeType, limits });
  signal?.throwIfAborted();
  // Conversions replace the buffer; unchanged bytes already have validated base64.
  const data =
    image.buffer === buffer && canonicalData ? canonicalData : image.buffer.toString("base64");
  return { type: "image", data, mimeType: image.mimeType };
}

export async function extractFileContentFromSource(params: {
  source: InputFileSource;
  limits: InputFileLimits;
  signal?: AbortSignal;
}): Promise<InputFileExtractResult> {
  const { source, limits, signal } = params;
  signal?.throwIfAborted();
  const filename = source.filename || "file";

  const { buffer, contentType } = await readInputSource(source, limits, "input_file", signal);
  const extracted = await extractFileContentFromBuffer({
    buffer,
    filename,
    mimeType: contentType,
    limits,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return extracted;
}

/** Extracts text from borrowed bytes or PDFs from owned bytes after shared size and MIME checks. */
export async function extractFileContentFromBuffer(params: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  charset?: string;
  limits: InputFileLimits;
  config?: OpenClawConfig;
  classification?: AttachmentClassification;
  signal?: AbortSignal;
}): Promise<InputFileExtractResult> {
  const { buffer, limits } = params;
  params.signal?.throwIfAborted();
  const filename = params.filename || "file";
  if (buffer.byteLength > limits.maxBytes) {
    throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`);
  }

  // Direct input_file callers declare their content type; the filename is
  // display metadata and must not override an explicitly allowlisted MIME.
  const classification =
    params.classification ??
    (await classifyAttachmentBytes({ buffer, declaredMime: params.mimeType }));
  params.signal?.throwIfAborted();
  const mimeType = classification.mime;
  const charset =
    classification.charset ?? params.charset ?? parseContentType(params.mimeType).charset;

  if (!mimeType) {
    throw new Error("input_file missing media type");
  }
  if (!limits.allowedMimes.has(mimeType)) {
    throw new Error(`Unsupported file MIME type: ${mimeType}`);
  }

  if (mimeType === "application/pdf") {
    const timeoutMs = resolveTimerTimeoutMs(limits.timeoutMs, 1);
    const controller = new AbortController();
    const signal = params.signal
      ? AbortSignal.any([params.signal, controller.signal])
      : controller.signal;
    signal.throwIfAborted();
    const timeout = setTimeout(
      () => controller.abort(new Error(`PDF extraction timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    let extracted: Awaited<ReturnType<typeof extractPdfContent>>;
    try {
      // Legacy extractors may not cooperate, but the worker receives the same cancellation.
      extracted = await racePromiseWithAbortSignal(
        () =>
          extractPdfContent({
            buffer,
            signal,
            maxPages: limits.pdf.maxPages,
            maxPixels: limits.pdf.maxPixels,
            minTextChars: limits.pdf.minTextChars,
            ...(params.config ? { config: params.config } : {}),
            onImageExtractionError: (err) => {
              logWarn(`media: PDF image extraction skipped, ${String(err)}`);
            },
          }),
        signal,
        (abortedSignal) => toErrorObject(abortedSignal.reason, "Input file extraction aborted"),
      );
    } finally {
      clearTimeout(timeout);
    }
    const text = truncateUtf16Safe(extracted.text, limits.maxChars);
    const metadata: DocumentExtractionMetadata = {
      ...extracted.metadata,
      textTruncated:
        extracted.metadata?.textTruncated === true || text.length < extracted.text.length,
      imagesTruncated: extracted.metadata?.imagesTruncated === true,
    };
    return {
      filename,
      text,
      images: extracted.images.length > 0 ? extracted.images : undefined,
      metadata,
    };
  }

  return { filename, ...decodeTextContent(buffer, charset, limits.maxChars) };
}
