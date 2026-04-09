import path from "node:path";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { SafeOpenError, readLocalFileSafely } from "../infra/fs-safe.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { maxBytesForKind, type MediaKind } from "./constants.js";
import { fetchRemoteMedia } from "./fetch.js";
import {
  convertHeicToJpeg,
  hasAlphaChannel,
  MAX_IMAGE_INPUT_PIXELS,
  optimizeImageToPng,
  resizeToJpeg,
} from "./image-ops.js";
import {
  assertLocalMediaAllowed,
  getDefaultLocalRoots,
  LocalMediaAccessError,
  type LocalMediaAccessErrorCode,
} from "./local-media-access.js";
import { detectMime, extensionForMime, kindFromMime, normalizeMimeType } from "./mime.js";

export { getDefaultLocalRoots, LocalMediaAccessError };
export type { LocalMediaAccessErrorCode };

export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
  ssrfPolicy?: SsrFPolicy;
  /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
  localRoots?: readonly string[] | "any";
  /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
  /** Host-local fs-policy read piggyback; rejects plaintext-like document sends. */
  hostReadCapability?: boolean;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

function resolveWebMediaOptions(params: {
  maxBytesOrOptions?: number | WebMediaOptions;
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" };
  optimizeImages: boolean;
}): WebMediaOptions {
  if (typeof params.maxBytesOrOptions === "number" || params.maxBytesOrOptions === undefined) {
    return {
      maxBytes: params.maxBytesOrOptions,
      optimizeImages: params.optimizeImages,
      ssrfPolicy: params.options?.ssrfPolicy,
      localRoots: params.options?.localRoots,
    };
  }
  return {
    ...params.maxBytesOrOptions,
    optimizeImages: params.optimizeImages
      ? (params.maxBytesOrOptions.optimizeImages ?? true)
      : false,
  };
}

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const HOST_READ_ALLOWED_DOCUMENT_MIMES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MB = 1024 * 1024;

function formatMb(bytes: number, digits = 2): string {
  return (bytes / MB).toFixed(digits);
}

function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMb(cap, 0)}MB limit (got ${formatMb(size)}MB)`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMb(cap, 0)}MB (got ${formatMb(size)}MB)`;
}

function isPixelLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`${MAX_IMAGE_INPUT_PIXELS.toLocaleString("en-US")} pixel input limit`)
  );
}

function isHeicSource(opts: { contentType?: string; fileName?: string }): boolean {
  if (HEIC_MIME_RE.test(normalizeOptionalString(opts.contentType) ?? "")) {
    return true;
  }
  if (HEIC_EXT_RE.test(normalizeOptionalString(opts.fileName) ?? "")) {
    return true;
  }
  return false;
}

function assertHostReadMediaAllowed(params: {
  contentType?: string;
  kind: MediaKind | undefined;
}): void {
  if (params.kind === "image" || params.kind === "audio" || params.kind === "video") {
    return;
  }
  if (params.kind !== "document") {
    const contentType = normalizeMimeType(params.contentType);
    throw new LocalMediaAccessError(
      "path-not-allowed",
      `Host-local media sends only allow images, audio, video, PDF, and Office documents (got ${contentType ?? "unknown"}).`,
    );
  }
  const normalizedMime = normalizeMimeType(params.contentType);
  if (normalizedMime && HOST_READ_ALLOWED_DOCUMENT_MIMES.has(normalizedMime)) {
    return;
  }
  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Host-local media sends only allow images, audio, video, PDF, and Office documents (got ${normalizedMime ?? "unknown"}).`,
  );
}

function toJpegFileName(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const trimmed = fileName.trim();
  if (!trimmed) {
    return fileName;
  }
  const parsed = path.parse(trimmed);
  if (!parsed.ext || HEIC_EXT_RE.test(parsed.ext)) {
    return path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext: ".jpg" });
  }
  return path.format({ dir: parsed.dir, name: parsed.name, ext: ".jpg" });
}

type OptimizedImage = {
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  format: "jpeg" | "png";
  quality?: number;
  compressionLevel?: number;
};

function logOptimizedImage(params: { originalSize: number; optimized: OptimizedImage }): void {
  if (!shouldLogVerbose()) {
    return;
  }
  if (params.optimized.optimizedSize >= params.originalSize) {
    return;
  }
  if (params.optimized.format === "png") {
    logVerbose(
      `Optimized PNG (preserving alpha) from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side<=${params.optimized.resizeSide}px)`,
    );
    return;
  }
  logVerbose(
    `Optimized media from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side<=${params.optimized.resizeSide}px, q=${params.optimized.quality})`,
  );
}

async function optimizeImageWithFallback(params: {
  buffer: Buffer;
  cap: number;
  meta?: { contentType?: string; fileName?: string };
}): Promise<OptimizedImage> {
  const { buffer, cap, meta } = params;
  const isPng =
    meta?.contentType === "image/png" ||
    normalizeLowercaseStringOrEmpty(meta?.fileName).endsWith(".png");
  const hasAlpha = isPng && (await hasAlphaChannel(buffer));

  if (hasAlpha) {
    const optimized = await optimizeImageToPng(buffer, cap);
    if (optimized.buffer.length <= cap) {
      return { ...optimized, format: "png" };
    }
    if (shouldLogVerbose()) {
      logVerbose(
        `PNG with alpha still exceeds ${formatMb(cap, 0)}MB after optimization; falling back to JPEG`,
      );
    }
  }

  const optimized = await optimizeImageToJpeg(buffer, cap, meta);
  return { ...optimized, format: "jpeg" };
}

async function loadWebMediaInternal(
  mediaUrl: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  const {
    maxBytes,
    optimizeImages = true,
    ssrfPolicy,
    localRoots,
    sandboxValidated = false,
    readFile: readFileOverride,
    hostReadCapability = false,
    workspaceDir,
  } = options;
  // Strip MEDIA: prefix used by agent tools (e.g. TTS) to tag media paths.
  // Be lenient: LLM output may add extra whitespace (e.g. "  MEDIA :  /tmp/x.png").
  mediaUrl = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
  // Use fileURLToPath for proper handling of file:// URLs (handles file://localhost/path, etc.)
  if (mediaUrl.startsWith("file://")) {
    try {
      mediaUrl = safeFileURLToPath(mediaUrl);
    } catch (err) {
      throw new LocalMediaAccessError("invalid-file-url", (err as Error).message, { cause: err });
    }
  }

  const optimizeAndClampImage = async (
    buffer: Buffer,
    cap: number,
    meta?: { contentType?: string; fileName?: string },
  ) => {
    const originalSize = buffer.length;
    const optimized = await optimizeImageWithFallback({ buffer, cap, meta });
    logOptimizedImage({ originalSize, optimized });

    if (optimized.buffer.length > cap) {
      throw new Error(formatCapReduce("Media", cap, optimized.buffer.length));
    }

    const contentType = optimized.format === "png" ? "image/png" : "image/jpeg";
    const fileName =
      optimized.format === "jpeg" && meta && isHeicSource(meta)
        ? toJpegFileName(meta.fileName)
        : meta?.fileName;

    return {
      buffer: optimized.buffer,
      contentType,
      kind: "image" as const,
      fileName,
    };
  };

  const clampAndFinalize = async (params: {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind | undefined;
    fileName?: string;
  }): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind ?? "document");
    if (params.kind === "image") {
      const isGif = params.contentType === "image/gif";
      if (isGif || !optimizeImages) {
        if (params.buffer.length > cap) {
          throw new Error(formatCapLimit(isGif ? "GIF" : "Media", cap, params.buffer.length));
        }
        return {
          buffer: params.buffer,
          contentType: params.contentType,
          kind: params.kind,
          fileName: params.fileName,
        };
      }
      return {
        ...(await optimizeAndClampImage(params.buffer, cap, {
          contentType: params.contentType,
          fileName: params.fileName,
        })),
      };
    }
    if (params.buffer.length > cap) {
      throw new Error(formatCapLimit("Media", cap, params.buffer.length));
    }
    return {
      buffer: params.buffer,
      contentType: params.contentType ?? undefined,
      kind: params.kind,
      fileName: params.fileName,
    };
  };

  if (/^https?:\/\//i.test(mediaUrl)) {
    // Enforce a download cap during fetch to avoid unbounded memory usage.
    // For optimized images, allow fetching larger payloads before compression.
    const defaultFetchCap = maxBytesForKind("document");
    const fetchCap =
      maxBytes === undefined
        ? defaultFetchCap
        : optimizeImages
          ? Math.max(maxBytes, defaultFetchCap)
          : maxBytes;
    const fetched = await fetchRemoteMedia({ url: mediaUrl, maxBytes: fetchCap, ssrfPolicy });
    const { buffer, contentType, fileName } = fetched;
    const kind = kindFromMime(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  // Expand tilde paths to absolute paths (e.g., ~/Downloads/photo.jpg)
  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }

  // Resolve relative MEDIA: paths (e.g. "poker_profit.png", "./subdir/file.png")
  // against the agent workspace directory so bare filenames written by agents
  // are found on disk and pass the local-roots allowlist check.
  if (workspaceDir && !path.isAbsolute(mediaUrl)) {
    mediaUrl = path.resolve(workspaceDir, mediaUrl);
  }
  try {
    assertNoWindowsNetworkPath(mediaUrl, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }

  if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
    throw new LocalMediaAccessError(
      "unsafe-bypass",
      "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
    );
  }

  // Guard local reads against allowed directory roots to prevent file exfiltration.
  if (!(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(mediaUrl, localRoots);
  }

  // Local path
  let data: Buffer;
  if (readFileOverride) {
    data = await readFileOverride(mediaUrl);
  } else {
    try {
      data = (await readLocalFileSafely({ filePath: mediaUrl })).buffer;
    } catch (err) {
      if (err instanceof SafeOpenError) {
        if (err.code === "not-found") {
          throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, {
            cause: err,
          });
        }
        if (err.code === "not-file") {
          throw new LocalMediaAccessError(
            "not-file",
            `Local media path is not a file: ${mediaUrl}`,
            { cause: err },
          );
        }
        throw new LocalMediaAccessError(
          "invalid-path",
          `Local media path is not safe to read: ${mediaUrl}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  const detectedMime = await detectMime({ buffer: data, filePath: mediaUrl });
  const verifiedMime = hostReadCapability ? await detectMime({ buffer: data }) : detectedMime;
  const mime = verifiedMime ?? detectedMime;
  const kind = kindFromMime(mime);
  let fileName = path.basename(mediaUrl) || undefined;
  if (fileName && !path.extname(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }
  if (hostReadCapability) {
    assertHostReadMediaAllowed({
      contentType: verifiedMime,
      kind: kindFromMime(detectedMime ?? verifiedMime),
    });
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
  });
}

export async function loadWebMedia(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: true }),
  );
}

export async function loadWebMediaRaw(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: false }),
  );
}

export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: { contentType?: string; fileName?: string } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  // Try a grid of sizes/qualities until under the limit.
  let source = buffer;
  if (isHeicSource(opts)) {
    try {
      source = await convertHeicToJpeg(buffer);
    } catch (err) {
      throw new Error(`HEIC image conversion failed: ${String(err)}`, { cause: err });
    }
  }
  const sides = [2048, 1536, 1280, 1024, 800];
  const qualities = [80, 70, 60, 50, 40];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    quality: number;
  } | null = null;

  for (const side of sides) {
    for (const quality of qualities) {
      try {
        const out = await resizeToJpeg({
          buffer: source,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, quality };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            quality,
          };
        }
      } catch (error) {
        if (isPixelLimitError(error)) {
          throw error;
        }
        // Continue trying other size/quality combinations
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      quality: smallest.quality,
    };
  }

  throw new Error("Failed to optimize image");
}

export { optimizeImageToPng };
