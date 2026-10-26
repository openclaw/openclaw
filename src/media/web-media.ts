import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { basenameFromAnyPath, extnameFromAnyPath } from "@openclaw/media-core/file-name";
import {
  detectMime,
  extensionForMime,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { resolveCanvasHttpPathToLocalPath } from "../canvas/documents.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError } from "../infra/fs-safe.js";
import type { PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { resolveUserPath } from "../utils.js";
import { readOutboundMediaFile } from "./bounded-read-file.js";
import { readRemoteMediaBuffer } from "./fetch.js";
import {
  pruneGeneratedHtmlProvenance,
  readGeneratedHtmlProvenance,
  writeGeneratedHtmlProvenance,
} from "./generated-html-provenance.js";
import {
  assertHostReadMediaAllowed,
  HOST_READ_DECLARED_TEXT_ERROR,
  type HostReadHtmlTrust,
} from "./host-read-media-policy.js";
import { ImageOptimizationLimitError } from "./image-optimization-error.js";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";
import { createImageProcessorWithPixelLimits } from "./image-processor.js";
import type { OutboundMediaReadFile } from "./load-options.js";
import {
  assertLocalMediaAllowed,
  getDefaultLocalRootsCore,
  HostReadMediaTypeError,
  LocalMediaAccessError,
  readLocalMediaFile,
  type LocalMediaAccessErrorCode,
} from "./local-media-access.js";
import { MediaReferenceError, resolveInboundMediaReference } from "./media-reference.js";
import {
  createImageProcessor,
  isAnimatedWebpBuffer,
  readImageMetadataFromHeader,
  readImageProbeFromHeader,
  type ImageMetadata,
} from "./media-services.js";
import { extractOriginalFilename, getMediaDir } from "./store.js";
import { formatMediaSize } from "./store.shared.js";

export { getDefaultLocalRootsCore, LocalMediaAccessError };
export type { LocalMediaAccessErrorCode };

/** Loaded media bytes plus resolved MIME kind and filename metadata for outbound/plugin callers. */
export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
  /** Source bytes came from a generated-HTML trust boundary. */
  trustedGeneratedHtmlSource?: boolean;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
  imageCompression?: ImageCompressionPolicy;
  ssrfPolicy?: SsrFPolicy;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  readIdleTimeoutMs?: number;
  trustExplicitProxyDns?: boolean;
  workspaceDir?: string;
  /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
  localRoots?: readonly string[] | "any";
  /** Channel inbound attachment root patterns checked with inbound path policy semantics. */
  inboundRoots?: readonly string[];
  /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
  sandboxValidated?: boolean;
  readFile?: OutboundMediaReadFile;
  /** Host-local fs-policy read piggyback; rejects plaintext-like document sends. */
  hostReadCapability?: boolean;
  /** Host-authored send intent; ordinary file access checks still apply. */
  htmlPublication?: "explicit";
};

export type ImageQualityPreference = "auto" | "efficient" | "balanced" | "high";

export type ImageCompressionModelPolicy = {
  maxBytes?: number;
  maxPixels?: number;
  maxSidePx?: number;
  preferredSidePx?: number;
};

export type ImageCompressionPolicy = {
  quality?: ImageQualityPreference;
  models?: ImageCompressionModelPolicy[];
  imageCount?: number;
};

async function resolveMediaStoreUriToPath(mediaUrl: string): Promise<string | null> {
  if (!/^media:\/\//i.test(mediaUrl)) {
    return null;
  }
  try {
    return (await resolveInboundMediaReference(mediaUrl))?.physicalPath ?? null;
  } catch (err) {
    if (err instanceof MediaReferenceError) {
      throw new LocalMediaAccessError(err.code, err.message, { cause: err });
    }
    throw err;
  }
}

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

// Pre-compression fetch headroom for callers with an explicit delivery cap:
// enough to pull a large phone photo (~20MB+) and compress it under the cap,
// without letting a tight channel cap buffer up to the 100MB document bound.
const IMAGE_OPTIMIZE_HEADROOM_FACTOR = 4;

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
function stripLegacyMediaDirectivePrefix(mediaUrl: string): string {
  if (/^\s*media:\/\//i.test(mediaUrl)) {
    return mediaUrl;
  }
  return mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
}

function resolveLocalMediaFileName(filePath: string): string | undefined {
  const fileName = basenameFromAnyPath(filePath) || undefined;
  return fileName && isPathInside(getMediaDir(), filePath)
    ? extractOriginalFilename(fileName)
    : fileName;
}

async function getTrustedGeneratedHtmlMarker(
  resolvedFilePath: string,
  context: OpenClawStateWorkerContext,
): Promise<{ sha256: string; size: number } | undefined> {
  try {
    const reply = await readGeneratedHtmlProvenance(context, {
      type: "generatedHtmlProvenance.read",
      input: resolvedFilePath,
    });
    return reply?.type === "generatedHtmlProvenance.read" ? reply.marker : undefined;
  } catch (error) {
    // State failures must narrow trust, never turn into a permissive fallback.
    logVerbose(
      `trusted-html marker lookup failed (${resolvedFilePath}): ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

async function resolveTrustedGeneratedHostReadHtml(
  filePath: string | undefined,
): Promise<HostReadHtmlTrust | undefined> {
  if (!filePath) {
    return undefined;
  }
  let context: OpenClawStateWorkerContext | undefined;
  try {
    context = captureOpenClawStateWorkerContext();
  } catch (error) {
    // Refused storage narrows outbound trust without changing the temp-root contract.
    logVerbose(`trusted-html admission failed: ${formatErrorMessage(error)}`);
  }
  const outboundPath = path.join(getMediaDir(), "outbound");
  const info = await lstat(filePath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return undefined;
  }
  const [resolvedFilePath, tmpRoot, outboundRoot] = await Promise.all([
    realpath(filePath).catch(() => undefined),
    realpath(resolvePreferredOpenClawTmpDir()).catch(() => undefined),
    realpath(outboundPath).catch(() => undefined),
  ]);
  if (!resolvedFilePath) {
    return undefined;
  }
  // Outbound staging always requires provenance, even when a custom state dir
  // places media/outbound underneath the otherwise trusted temp root.
  if (outboundRoot && isPathInside(outboundRoot, resolvedFilePath)) {
    const marker = context
      ? await getTrustedGeneratedHtmlMarker(resolvedFilePath, context)
      : undefined;
    return marker
      ? { source: "outbound", expectedSha256: marker.sha256, expectedSize: marker.size }
      : undefined;
  }
  return tmpRoot && isPathInside(tmpRoot, resolvedFilePath) ? { source: "temp-root" } : undefined;
}

/** Records exact-byte provenance for a trusted generated HTML staged outbound. */
export async function markTrustedGeneratedHtmlPath(
  filePath: string,
  contents: Buffer,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const outboundPath = path.join(getMediaDir(), "outbound");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const sizeBytes = contents.length;
  const resolvedFilePath = await realpath(filePath);
  const outboundRoot = await realpath(outboundPath).catch(() => undefined);
  if (!outboundRoot || !isPathInside(outboundRoot, resolvedFilePath)) {
    throw new Error(
      `markTrustedGeneratedHtmlPath: refusing path outside outbound staging: ${resolvedFilePath}`,
    );
  }
  await writeGeneratedHtmlProvenance(context, {
    type: "generatedHtmlProvenance.upsert",
    input: {
      realpath: resolvedFilePath,
      kind: "trusted-generated-html",
      version: 1,
      sha256,
      size_bytes: sizeBytes,
      created_at_ms: Date.now(),
    },
  });
}

/** Removes provenance whose staged regular file no longer exists. */
export async function pruneStaleTrustedGeneratedHtmlMarkers(): Promise<void> {
  await pruneGeneratedHtmlProvenance(captureOpenClawStateWorkerContext());
}

function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMediaSize(cap)} limit (got ${formatMediaSize(size)})`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMediaSize(cap)} (got ${formatMediaSize(size)})`;
}

// Queue custody keeps artifact paths; public image names describe the encoded bytes.
function reconcileImageFileName(media: WebMediaResult): WebMediaResult {
  if (media.kind !== "image" || !media.fileName) {
    return media;
  }
  const fileName = basenameFromAnyPath(media.fileName.trim());
  if (!fileName) {
    return media;
  }
  const contentType = normalizeMimeType(media.contentType);
  const extension = extensionForMime(contentType);
  if (!extension || mimeTypeFromFilePath(fileName) === contentType) {
    return { ...media, fileName };
  }
  const parsed = path.parse(fileName);
  return {
    ...media,
    fileName: path.format({ name: parsed.name || fileName, ext: extension }),
  };
}

const DEFAULT_VISION_MAX_SIDE = 2048;
const LOW_IMAGE_SIDE_FALLBACKS = [640, 512, 384, 256, 192, 128] as const;

function effectiveImageQualityPreference(
  policy?: ImageCompressionPolicy,
): Exclude<ImageQualityPreference, "auto"> {
  const preference = policy?.quality;
  if (preference === "efficient" || preference === "balanced" || preference === "high") {
    return preference;
  }
  const imageCount = Math.max(1, Math.floor(policy?.imageCount ?? 1));
  if (imageCount >= 6) {
    return "efficient";
  }
  return "balanced";
}

function maxSideForModel(model: ImageCompressionModelPolicy | undefined): number {
  const maxSide = floorPositiveFiniteNumber(model?.maxSidePx);
  const maxPixels = floorPositiveFiniteNumber(model?.maxPixels);
  const hardLimits = [maxSide, maxPixels ? Math.floor(Math.sqrt(maxPixels)) : undefined].filter(
    (value): value is number => value !== undefined,
  );
  if (hardLimits.length > 0) {
    return Math.min(...hardLimits);
  }
  return floorPositiveFiniteNumber(model?.preferredSidePx) ?? DEFAULT_VISION_MAX_SIDE;
}

function sideForPreference(
  preference: Exclude<ImageQualityPreference, "auto">,
  policy?: ImageCompressionPolicy,
): number {
  const models = policy?.models?.length ? policy.models : [undefined];
  const maxSide = Math.min(...models.map((model) => maxSideForModel(model)));
  const preferredSide = Math.min(
    ...models.map(
      (model) =>
        floorPositiveFiniteNumber(model?.preferredSidePx) ??
        Math.min(maxSideForModel(model), DEFAULT_VISION_MAX_SIDE),
    ),
  );
  switch (preference) {
    case "efficient":
      return Math.min(preferredSide, maxSide, 1280);
    case "high":
      return maxSide;
    default:
      return Math.min(preferredSide, maxSide);
  }
}

function imageMaxBytesForPolicy(policy?: ImageCompressionPolicy): number | undefined {
  const maxBytes = policy?.models
    ?.map((model) => floorPositiveFiniteNumber(model.maxBytes))
    .filter((value): value is number => value !== undefined);
  return maxBytes?.length ? Math.min(...maxBytes) : undefined;
}

function imageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
  metadata?: ImageMetadata,
): boolean {
  const models = policy?.models ?? [];
  const hardMaxSide = Math.min(
    ...models.map((model) => floorPositiveFiniteNumber(model.maxSidePx) ?? Infinity),
  );
  const hardMaxPixels = Math.min(
    ...models.map((model) => floorPositiveFiniteNumber(model.maxPixels) ?? Infinity),
  );
  if (hardMaxSide === Infinity && hardMaxPixels === Infinity) {
    return true;
  }
  const meta = metadata ?? readImageMetadataFromHeader(buffer);
  return Boolean(
    meta &&
    Math.max(meta.width, meta.height) <= hardMaxSide &&
    meta.width * meta.height <= hardMaxPixels,
  );
}

function assertImageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
): void {
  if (imageSatisfiesHardDimensionPolicy(buffer, policy)) {
    return;
  }
  const meta = readImageMetadataFromHeader(buffer);
  const detail = meta ? `: ${meta.width}x${meta.height}` : "";
  throw new Error(`Image dimensions exceed model image limits${detail}`);
}

function isPreservableImageMime(
  contentType: string | undefined,
): contentType is "image/png" | "image/jpeg" | "image/webp" {
  return (
    contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
  );
}

export function effectiveImageBytesCap(
  baseCap: number | undefined,
  policy?: ImageCompressionPolicy,
): number | undefined {
  const policyCap = imageMaxBytesForPolicy(policy);
  if (baseCap === undefined) {
    return policyCap;
  }
  return policyCap === undefined ? baseCap : Math.min(baseCap, policyCap);
}

function buildDescendingLadder(maxSide: number, values: readonly number[]): number[] {
  const normalizedMax = Math.max(1, Math.floor(maxSide));
  const ladder = uniqueValues(
    [normalizedMax, ...values, ...LOW_IMAGE_SIDE_FALLBACKS]
      .map((value) => Math.min(normalizedMax, value))
      .filter((value) => value > 0),
  ).toSorted((a, b) => b - a);
  if (ladder.length > 1 || normalizedMax <= 1) {
    return ladder;
  }
  const fallbackLadder = [
    normalizedMax,
    Math.floor(normalizedMax * 0.75),
    Math.floor(normalizedMax * 0.5),
    Math.floor(normalizedMax * 0.25),
  ];
  return uniqueValues(fallbackLadder.filter((value) => value > 0)).toSorted((a, b) => b - a);
}

const IMAGE_COMPRESSION_GRIDS = {
  efficient: { sides: [1024, 800], qualities: [70, 60, 50, 40] },
  high: {
    sides: [3072, 2576, 2048, 1800, 1536, 1280, 1024, 800],
    qualities: [92, 85, 78, 70, 62, 52, 42],
  },
  balanced: { sides: [2048, 1536, 1280, 1024, 800], qualities: [80, 70, 60, 50, 40] },
} as const;

function resolveImageCompressionGrid(policy?: ImageCompressionPolicy): {
  sides: number[];
  qualities: number[];
} {
  const preference = effectiveImageQualityPreference(policy);
  const grid = IMAGE_COMPRESSION_GRIDS[preference];
  return {
    sides: buildDescendingLadder(sideForPreference(preference, policy), grid.sides),
    qualities: [...grid.qualities],
  };
}

/** Optimizes image bytes for web-media delivery while preserving accepted original formats when possible. */
export async function optimizeImageBufferForWebMedia(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  maxBytes?: number;
  imageCompression?: ImageCompressionPolicy;
  maxInputPixels?: number;
}): Promise<WebMediaResult> {
  const baseCap = params.maxBytes ?? maxBytesForKind("image");
  const cap = effectiveImageBytesCap(baseCap, params.imageCompression) ?? baseCap;
  const isAnimatedWebp = isAnimatedWebpBuffer(params.buffer);
  let originalContentType = isAnimatedWebp ? "image/webp" : (params.contentType ?? null);
  if (originalContentType === "image/gif" || isAnimatedWebp) {
    if (params.buffer.length > cap) {
      const format = isAnimatedWebp ? "Animated WebP" : "GIF";
      throw new ImageOptimizationLimitError(formatCapLimit(format, cap, params.buffer.length), cap);
    }
    assertImageSatisfiesHardDimensionPolicy(params.buffer, params.imageCompression);
  } else {
    originalContentType = (() => {
      const { buffer, contentType, imageCompression: policy } = params;
      if (buffer.length > cap) {
        return null;
      }
      const declaredContentType = normalizeMimeType(contentType);
      const probe = readImageProbeFromHeader(buffer);
      const actualContentType = probe ? `image/${probe.format}` : undefined;
      if (!probe || !isPreservableImageMime(actualContentType)) {
        return null;
      }
      const declaredPreservableContentType = isPreservableImageMime(declaredContentType)
        ? declaredContentType
        : undefined;
      if (declaredPreservableContentType && declaredPreservableContentType !== actualContentType) {
        return null;
      }
      if (declaredContentType?.startsWith("image/") && !declaredPreservableContentType) {
        return null;
      }
      const preferredSide = resolveImageCompressionGrid(policy).sides[0] ?? DEFAULT_VISION_MAX_SIDE;
      if (
        Math.max(probe.width, probe.height) > preferredSide ||
        !imageSatisfiesHardDimensionPolicy(buffer, policy, probe)
      ) {
        return null;
      }
      return declaredPreservableContentType ?? actualContentType;
    })();
  }
  if (originalContentType) {
    return reconcileImageFileName({
      buffer: params.buffer,
      contentType: originalContentType,
      kind: "image",
      fileName: params.fileName,
    });
  }
  const grid = resolveImageCompressionGrid(params.imageCompression);
  // Generic callers keep the shared decode limit. An owner with a bounded downscale path may
  // widen source admission explicitly, while every encoded result remains under the output cap.
  const processor = createImageProcessorWithPixelLimits({
    inputPixels: params.maxInputPixels ?? MAX_IMAGE_INPUT_PIXELS,
    outputPixels: MAX_IMAGE_INPUT_PIXELS,
  });
  const optimized = await processor.encode(params.buffer, {
    format: "auto",
    maxBytes: cap,
    opaque: { format: "jpeg" },
    transparent: { format: "png" },
    search: { maxSide: grid.sides, quality: grid.qualities },
    transparency: "auto",
  });
  if (optimized.data.length > cap) {
    throw new ImageOptimizationLimitError(
      formatCapReduce("Media", cap, optimized.data.length),
      cap,
    );
  }
  return reconcileImageFileName({
    buffer: optimized.data,
    contentType: optimized.mimeType,
    kind: "image",
    fileName: params.fileName,
  });
}

async function loadWebMediaInternal(
  mediaUrlInput: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  let mediaUrl = mediaUrlInput;
  const {
    maxBytes,
    optimizeImages = true,
    ssrfPolicy,
    proxyUrl,
    fetchImpl,
    requestInit,
    readIdleTimeoutMs,
    trustExplicitProxyDns,
    workspaceDir,
    localRoots,
    inboundRoots,
    sandboxValidated = false,
    readFile: readFileOverride,
    hostReadCapability = false,
    htmlPublication,
    imageCompression,
  } = options;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);
  mediaUrl = (await resolveMediaStoreUriToPath(mediaUrl)) ?? mediaUrl;
  if (/^file:/iu.test(mediaUrl)) {
    try {
      mediaUrl = safeFileURLToPath(mediaUrl);
    } catch (err) {
      throw new LocalMediaAccessError("invalid-file-url", (err as Error).message, { cause: err });
    }
  }
  mediaUrl = resolveCanvasHttpPathToLocalPath(mediaUrl) ?? mediaUrl;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);

  const clampAndFinalize = async (params: WebMediaResult): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind ?? "document");
    if (params.kind === "image") {
      if (optimizeImages) {
        return await optimizeImageBufferForWebMedia({
          buffer: params.buffer,
          contentType: params.contentType,
          fileName: params.fileName,
          maxBytes: cap,
          imageCompression,
        });
      }
      const imageCap = effectiveImageBytesCap(cap, imageCompression) ?? cap;
      const isGif = params.contentType === "image/gif";
      if (params.buffer.length > imageCap) {
        throw new Error(formatCapLimit(isGif ? "GIF" : "Media", imageCap, params.buffer.length));
      }
      assertImageSatisfiesHardDimensionPolicy(params.buffer, imageCompression);
      return {
        buffer: params.buffer,
        contentType: params.contentType,
        kind: params.kind,
        fileName: params.fileName,
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
      ...(params.trustedGeneratedHtmlSource ? { trustedGeneratedHtmlSource: true } : {}),
    };
  };

  // Bound source reads before buffering. Optimized images may exceed their
  // delivery cap because they are compressed before the final size check, so
  // an explicit caller cap gets image-compression headroom — sized off the
  // image cap, not the 100MB document cap, or a tight channel cap would still
  // permit a 100MB buffer from a hostile URL. Accepted tradeoff: originals
  // above the headroom fail even when they would have compressed under the
  // cap; the error names the fetch bound so the user can shrink the source.
  const defaultSourceReadCap = maxBytesForKind("document");
  const imageOptimizeHeadroom = IMAGE_OPTIMIZE_HEADROOM_FACTOR * maxBytesForKind("image");
  const sourceReadCap =
    maxBytes === undefined
      ? defaultSourceReadCap
      : optimizeImages
        ? Math.max(maxBytes, imageOptimizeHeadroom)
        : maxBytes;

  if (hasHttpUrlPrefix(mediaUrl)) {
    const dispatcherPolicy: PinnedDispatcherPolicy | undefined = proxyUrl
      ? {
          mode: "explicit-proxy",
          proxyUrl,
          allowPrivateProxy: true,
        }
      : undefined;
    const fetched = await readRemoteMediaBuffer({
      url: mediaUrl,
      fetchImpl,
      requestInit,
      readIdleTimeoutMs,
      maxBytes: sourceReadCap,
      ssrfPolicy,
      dispatcherPolicy,
      trustExplicitProxyDns,
    });
    const { buffer, contentType, fileName } = fetched;
    const kind = kindFromMime(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }
  if (workspaceDir && !path.isAbsolute(mediaUrl) && !WINDOWS_DRIVE_RE.test(mediaUrl)) {
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
  if (readFileOverride && !(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(mediaUrl, localRoots, { inboundRoots });
  }

  const hostReadDeclaredMime =
    hostReadCapability || htmlPublication === "explicit"
      ? normalizeMimeType(mimeTypeFromFilePath(mediaUrl))
      : undefined;
  const explicitHtmlPublication =
    hostReadDeclaredMime === "text/html" && htmlPublication === "explicit";
  const htmlTrust =
    hostReadDeclaredMime === "text/html" && !explicitHtmlPublication
      ? await resolveTrustedGeneratedHostReadHtml(mediaUrl)
      : undefined;
  if (hostReadDeclaredMime === "text/html" && !htmlTrust && !explicitHtmlPublication) {
    throw new HostReadMediaTypeError(HOST_READ_DECLARED_TEXT_ERROR);
  }

  let data: Buffer;
  if (readFileOverride) {
    data = await readOutboundMediaFile(readFileOverride, mediaUrl, { maxBytes: sourceReadCap });
  } else {
    try {
      data = await readLocalMediaFile(mediaUrl, localRoots, {
        ...(inboundRoots ? { inboundRoots } : {}),
        maxBytes: sourceReadCap,
      });
    } catch (err) {
      if (err instanceof FsSafeError) {
        if (err.code === "too-large") {
          throw new Error(`Media exceeds ${formatMediaSize(sourceReadCap)} limit`, {
            cause: err,
          });
        }
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
        if (err.code === "path-mismatch") {
          // fs-safe reports pre-open identity drift as path-mismatch; keep the
          // product-facing classification as an access denial, not a bad path.
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaUrl}`,
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
  const validateHostReadMedia = hostReadCapability || explicitHtmlPublication;
  const sniffedMime = validateHostReadMedia ? await detectMime({ buffer: data }) : undefined;
  const mime = await detectMime({ buffer: data, filePath: mediaUrl });
  const kind = kindFromMime(mime);
  if (validateHostReadMedia) {
    assertHostReadMediaAllowed({
      sniffedContentType: sniffedMime,
      contentType: mime,
      filePath: mediaUrl,
      kind,
      buffer: data,
      trustedGeneratedHtmlPath: htmlTrust,
      explicitHtmlPublication,
    });
  }
  let fileName = resolveLocalMediaFileName(mediaUrl);
  if (fileName && !extnameFromAnyPath(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
    trustedGeneratedHtmlSource: Boolean(htmlTrust && hostReadDeclaredMime === "text/html"),
  });
}

/** Loads local, remote, hosted, or media-store media and optimizes images by default. */
export async function loadWebMedia(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return reconcileImageFileName(
    await loadWebMediaInternal(
      mediaUrl,
      resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: true }),
    ),
  );
}

/** Loads local, remote, hosted, or media-store media without image optimization. */
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

/** Optimizes image bytes to JPEG under a target byte cap using the shared compression grid. */
export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: {
    contentType?: string;
    fileName?: string;
    imageCompression?: ImageCompressionPolicy;
  } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  const { sides, qualities } = resolveImageCompressionGrid(opts.imageCompression);
  const optimized = await createImageProcessor().encode(buffer, {
    format: "auto",
    maxBytes,
    opaque: { format: "jpeg" },
    search: {
      maxSide: sides,
      quality: qualities,
    },
    transparency: "flatten",
  });
  return {
    buffer: optimized.data,
    optimizedSize: optimized.bytes,
    resizeSide: optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height),
    quality: optimized.chosen.quality ?? qualities.at(-1) ?? 85,
  };
}

export { optimizeImageToPng } from "./media-services.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
