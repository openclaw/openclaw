import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runExec } from "../process/exec.js";
import { createLazyPromiseLoader } from "../shared/lazy-promise.js";

export type ImageMetadata = {
  width: number;
  height: number;
};

type MediaAttachmentImageOps = {
  getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null>;
  normalizeExifOrientation(buffer: Buffer): Promise<Buffer>;
  resizeToJpeg(params: {
    buffer: Buffer;
    maxSide: number;
    quality: number;
    withoutEnlargement?: boolean;
  }): Promise<Buffer>;
  convertHeicToJpeg(buffer: Buffer): Promise<Buffer>;
  hasAlphaChannel(buffer: Buffer): Promise<boolean>;
  resizeToPng(params: {
    buffer: Buffer;
    maxSide: number;
    compressionLevel?: number;
    withoutEnlargement?: boolean;
  }): Promise<Buffer>;
};

type MediaAttachmentImageOpsModule = {
  createMediaAttachmentImageOps?: (options: { maxInputPixels: number }) => MediaAttachmentImageOps;
};

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;
const MEDIA_UNDERSTANDING_CORE_PLUGIN_ID = "media-understanding-core";
const MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT = "image-ops.js";
const DEFAULT_IMAGE_WORKER_TIMEOUT_MS = 30_000;
const DEFAULT_IMAGE_WORKER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const IMAGE_WORKER_MAX_STDOUT_BYTES = 256 * 1024;
const IMAGE_WORKER_MAX_STDERR_BYTES = 256 * 1024;

export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

function isBun(): boolean {
  return typeof (process.versions as { bun?: unknown }).bun === "string";
}

function prefersSips(): boolean {
  return (
    process.env.OPENCLAW_IMAGE_BACKEND === "sips" ||
    (process.env.OPENCLAW_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin")
  );
}

function isMediaAttachmentImageOps(value: unknown): value is MediaAttachmentImageOps {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Record<keyof MediaAttachmentImageOps, unknown>>;
  return (
    typeof candidate.getImageMetadata === "function" &&
    typeof candidate.normalizeExifOrientation === "function" &&
    typeof candidate.resizeToJpeg === "function" &&
    typeof candidate.convertHeicToJpeg === "function" &&
    typeof candidate.hasAlphaChannel === "function" &&
    typeof candidate.resizeToPng === "function"
  );
}

const mediaAttachmentImageOpsLoader = createLazyPromiseLoader(async () => {
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  const mod = loadBundledPluginPublicArtifactModuleSync<MediaAttachmentImageOpsModule>({
    dirName: MEDIA_UNDERSTANDING_CORE_PLUGIN_ID,
    artifactBasename: MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT,
  });
  const ops = mod.createMediaAttachmentImageOps?.({
    maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
  });
  if (!isMediaAttachmentImageOps(ops)) {
    throw new Error("Media understanding core did not expose image ops");
  }
  return ops;
});

async function loadInProcessMediaAttachmentImageOps(): Promise<MediaAttachmentImageOps> {
  return await mediaAttachmentImageOpsLoader.load();
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return null;
  }
}

export function resolveImageOpsWorkerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.OPENCLAW_IMAGE_WORKER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMAGE_WORKER_TIMEOUT_MS;
}

export function resolveImageOpsWorkerMaxOutputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.OPENCLAW_IMAGE_WORKER_MAX_OUTPUT_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMAGE_WORKER_MAX_OUTPUT_BYTES;
}

function shouldUseImageOpsWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (prefersSips()) {
    return false;
  }
  return parseBooleanEnv(env.OPENCLAW_IMAGE_WORKER) !== false;
}

function resolvePackageRootForImageOpsWorker(): string | null {
  return resolveOpenClawPackageRootSync({
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
}

function resolveImageOpsWorkerPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = env.OPENCLAW_IMAGE_OPS_WORKER_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const packageRoot = resolvePackageRootForImageOpsWorker();
  if (packageRoot) {
    const distWorkerPath = path.join(packageRoot, "dist", "media", "image-ops-worker.js");
    if (existsSync(distWorkerPath)) {
      return distWorkerPath;
    }
    const sourceWorkerPath = path.join(packageRoot, "src", "media", "image-ops-worker.ts");
    if (existsSync(sourceWorkerPath)) {
      return sourceWorkerPath;
    }
    return distWorkerPath;
  }

  return fileURLToPath(new URL("./image-ops-worker.js", import.meta.url));
}

function buildImageOpsWorkerArgv(workerPath: string): string[] {
  if (path.extname(workerPath).toLowerCase() === ".ts") {
    return [process.execPath, "--import", "tsx", workerPath];
  }
  return [process.execPath, workerPath];
}

type ImageOpsWorkerRequest =
  | {
      operation: "getImageMetadata" | "normalizeExifOrientation" | "convertHeicToJpeg";
      inputPath: string;
      outputPath?: string;
      maxInputPixels: number;
    }
  | {
      operation: "resizeToJpeg";
      inputPath: string;
      outputPath: string;
      maxInputPixels: number;
      maxSide: number;
      quality: number;
      withoutEnlargement?: boolean;
    }
  | {
      operation: "hasAlphaChannel";
      inputPath: string;
      maxInputPixels: number;
    }
  | {
      operation: "resizeToPng";
      inputPath: string;
      outputPath: string;
      maxInputPixels: number;
      maxSide: number;
      compressionLevel?: number;
      withoutEnlargement?: boolean;
    };

type ImageOpsWorkerSuccessResponse = { ok: true; metadata?: ImageMetadata | null; value?: boolean };
type ImageOpsWorkerFailureResponse = { ok: false; error?: string };
type ImageOpsWorkerResponse = ImageOpsWorkerSuccessResponse | ImageOpsWorkerFailureResponse;

function appendLimitedChunk(params: {
  chunks: Buffer[];
  chunk: Buffer;
  maxBytes: number;
  streamName: string;
  kill: () => void;
}): boolean {
  const currentBytes = params.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (currentBytes + params.chunk.length > params.maxBytes) {
    params.kill();
    throw new Error(`Image worker ${params.streamName} exceeded output limit`);
  }
  params.chunks.push(params.chunk);
  return true;
}

async function invokeImageOpsWorker(
  request: ImageOpsWorkerRequest,
): Promise<ImageOpsWorkerSuccessResponse> {
  const workerPath = resolveImageOpsWorkerPath();
  const argv = buildImageOpsWorkerArgv(workerPath);
  const input = JSON.stringify(request);
  const timeoutMs = resolveImageOpsWorkerTimeoutMs();

  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0] ?? process.execPath, argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const killChild = () => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    child.stdin?.on("error", () => {});
    child.stdin?.end(input);

    child.stdout?.on("data", (chunk) => {
      try {
        appendLimitedChunk({
          chunks: stdoutChunks,
          chunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          maxBytes: IMAGE_WORKER_MAX_STDOUT_BYTES,
          streamName: "stdout",
          kill: killChild,
        });
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stderr?.on("data", (chunk) => {
      try {
        appendLimitedChunk({
          chunks: stderrChunks,
          chunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
          maxBytes: IMAGE_WORKER_MAX_STDERR_BYTES,
          streamName: "stderr",
          kill: killChild,
        });
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.on("error", (error) => {
      finishReject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (timedOut) {
        reject(new Error(`Image worker timed out after ${timeoutMs}ms`));
        return;
      }
      let response: ImageOpsWorkerResponse | null = null;
      if (stdout) {
        try {
          response = JSON.parse(stdout) as ImageOpsWorkerResponse;
        } catch {
          // The status check below reports the raw output as context.
        }
      }
      if (code !== 0 || signal) {
        reject(
          new Error(
            response?.ok === false && response.error
              ? response.error
              : `Image worker failed with ${signal ?? `exit code ${code}`}${stderr ? `: ${stderr}` : ""}`,
          ),
        );
        return;
      }
      if (!response) {
        reject(new Error(`Image worker did not return valid JSON${stdout ? `: ${stdout}` : ""}`));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error ?? "Image worker failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function runImageOpsWorkerWithBuffer<T>(params: {
  buffer: Buffer;
  buildRequest: (paths: { inputPath: string; outputPath: string }) => ImageOpsWorkerRequest;
  readResult: (
    paths: { outputPath: string },
    response: ImageOpsWorkerSuccessResponse,
  ) => Promise<T>;
}): Promise<T> {
  return await withTempDir(async (dir) => {
    const inputPath = path.join(dir, "input.img");
    const outputPath = path.join(dir, "output.img");
    await fs.writeFile(inputPath, params.buffer);
    const response = await invokeImageOpsWorker(params.buildRequest({ inputPath, outputPath }));
    return await params.readResult({ outputPath }, response);
  });
}

async function readImageOpsWorkerOutputFile(outputPath: string): Promise<Buffer> {
  const stat = await fs.stat(outputPath);
  const maxOutputBytes = resolveImageOpsWorkerMaxOutputBytes();
  if (stat.size > maxOutputBytes) {
    throw new Error(`Image worker output exceeded ${maxOutputBytes} bytes`);
  }
  return await fs.readFile(outputPath);
}

const workerBackedMediaAttachmentImageOps: MediaAttachmentImageOps = {
  async getImageMetadata(buffer) {
    return await runImageOpsWorkerWithBuffer({
      buffer,
      buildRequest: ({ inputPath }) => ({
        operation: "getImageMetadata",
        inputPath,
        maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
      }),
      readResult: async (_paths, response) => response.metadata ?? null,
    });
  },
  async normalizeExifOrientation(buffer) {
    return await runImageOpsWorkerWithBuffer({
      buffer,
      buildRequest: ({ inputPath, outputPath }) => ({
        operation: "normalizeExifOrientation",
        inputPath,
        outputPath,
        maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
      }),
      readResult: async ({ outputPath }) => await readImageOpsWorkerOutputFile(outputPath),
    });
  },
  async resizeToJpeg(params) {
    return await runImageOpsWorkerWithBuffer({
      buffer: params.buffer,
      buildRequest: ({ inputPath, outputPath }) => ({
        operation: "resizeToJpeg",
        inputPath,
        outputPath,
        maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
        maxSide: params.maxSide,
        quality: params.quality,
        withoutEnlargement: params.withoutEnlargement,
      }),
      readResult: async ({ outputPath }) => await readImageOpsWorkerOutputFile(outputPath),
    });
  },
  async convertHeicToJpeg(buffer) {
    return await runImageOpsWorkerWithBuffer({
      buffer,
      buildRequest: ({ inputPath, outputPath }) => ({
        operation: "convertHeicToJpeg",
        inputPath,
        outputPath,
        maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
      }),
      readResult: async ({ outputPath }) => await readImageOpsWorkerOutputFile(outputPath),
    });
  },
  async hasAlphaChannel(buffer) {
    return await runImageOpsWorkerWithBuffer({
      buffer,
      buildRequest: ({ inputPath }) => ({
        operation: "hasAlphaChannel",
        inputPath,
        maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
      }),
      readResult: async (_paths, response) => response.value === true,
    });
  },
  async resizeToPng(params) {
    return await runImageOpsWorkerWithBuffer({
      buffer: params.buffer,
      buildRequest: ({ inputPath, outputPath }) => ({
        operation: "resizeToPng",
        inputPath,
        outputPath,
        maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
        maxSide: params.maxSide,
        compressionLevel: params.compressionLevel,
        withoutEnlargement: params.withoutEnlargement,
      }),
      readResult: async ({ outputPath }) => await readImageOpsWorkerOutputFile(outputPath),
    });
  },
};

async function loadMediaAttachmentImageOps(): Promise<MediaAttachmentImageOps> {
  if (shouldUseImageOpsWorker()) {
    return workerBackedMediaAttachmentImageOps;
  }
  return await loadInProcessMediaAttachmentImageOps();
}

function isPositiveImageDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function buildImageMetadata(width: number, height: number): ImageMetadata | null {
  if (!isPositiveImageDimension(width) || !isPositiveImageDimension(height)) {
    return null;
  }
  return { width, height };
}

function readPngMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 24) {
    return null;
  }
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47 ||
    buffer[4] !== 0x0d ||
    buffer[5] !== 0x0a ||
    buffer[6] !== 0x1a ||
    buffer[7] !== 0x0a ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return buildImageMetadata(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function readGifMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 10) {
    return null;
  }
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return null;
  }
  return buildImageMetadata(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function readWebpMetadata(buffer: Buffer): ImageMetadata | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X") {
    if (buffer.length < 30) {
      return null;
    }
    return buildImageMetadata(1 + buffer.readUIntLE(24, 3), 1 + buffer.readUIntLE(27, 3));
  }
  if (chunkType === "VP8 ") {
    if (buffer.length < 30) {
      return null;
    }
    return buildImageMetadata(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }
  if (chunkType === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return null;
    }
    const bits = buffer[21] | (buffer[22] << 8) | (buffer[23] << 16) | (buffer[24] << 24);
    return buildImageMetadata((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

function readJpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 8 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset++;
    }
    if (offset >= buffer.length) {
      return null;
    }

    const marker = buffer[offset];
    offset++;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= buffer.length) {
      return null;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return null;
    }

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (segmentLength < 7 || offset + 6 >= buffer.length) {
        return null;
      }
      return buildImageMetadata(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }

    offset += segmentLength;
  }

  return null;
}

function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return (
    readPngMetadata(buffer) ??
    readGifMetadata(buffer) ??
    readWebpMetadata(buffer) ??
    readJpegMetadata(buffer)
  );
}

function countImagePixels(meta: ImageMetadata): number | null {
  const pixels = meta.width * meta.height;
  return Number.isSafeInteger(pixels) ? pixels : null;
}

function exceedsImagePixelLimit(meta: ImageMetadata): boolean {
  return meta.width > Math.floor(MAX_IMAGE_INPUT_PIXELS / meta.height);
}

function createImagePixelLimitError(meta: ImageMetadata): Error {
  const pixelCount = countImagePixels(meta);
  const detail =
    pixelCount === null
      ? `${meta.width}x${meta.height}`
      : `${meta.width}x${meta.height} (${pixelCount} pixels)`;
  return new Error(
    `Image dimensions exceed the ${MAX_IMAGE_INPUT_PIXELS.toLocaleString("en-US")} pixel input limit: ${detail}`,
  );
}

function validateImagePixelLimit(meta: ImageMetadata): ImageMetadata {
  if (exceedsImagePixelLimit(meta)) {
    throw createImagePixelLimitError(meta);
  }
  return meta;
}

async function readImageMetadataForLimit(buffer: Buffer): Promise<ImageMetadata | null> {
  return readImageMetadataFromHeader(buffer);
}

async function assertImagePixelLimit(buffer: Buffer): Promise<void> {
  const meta = await readImageMetadataForLimit(buffer);
  if (!meta) {
    if (prefersSips()) {
      throw new Error("Unable to determine image dimensions; refusing to process");
    }
    return;
  }
  validateImagePixelLimit(meta);
}

/**
 * Reads EXIF orientation from JPEG buffer.
 * Returns orientation value 1-8, or null if not found/not JPEG.
 *
 * EXIF orientation values:
 * 1 = Normal, 2 = Flip H, 3 = Rotate 180, 4 = Flip V,
 * 5 = Rotate 270 CW + Flip H, 6 = Rotate 90 CW, 7 = Rotate 90 CW + Flip H, 8 = Rotate 270 CW
 */
function readJpegExifOrientation(buffer: Buffer): number | null {
  // Check JPEG magic bytes
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 4) {
    // Look for marker
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // Skip padding FF bytes
    if (marker === 0xff) {
      offset++;
      continue;
    }

    // APP1 marker (EXIF)
    if (marker === 0xe1) {
      const exifStart = offset + 4;

      // Check for "Exif\0\0" header
      if (
        buffer.length > exifStart + 6 &&
        buffer.toString("ascii", exifStart, exifStart + 4) === "Exif" &&
        buffer[exifStart + 4] === 0 &&
        buffer[exifStart + 5] === 0
      ) {
        const tiffStart = exifStart + 6;
        if (buffer.length < tiffStart + 8) {
          return null;
        }

        // Check byte order (II = little-endian, MM = big-endian)
        const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
        const isLittleEndian = byteOrder === "II";

        const readU16 = (pos: number) =>
          isLittleEndian ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos);
        const readU32 = (pos: number) =>
          isLittleEndian ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);

        // Read IFD0 offset
        const ifd0Offset = readU32(tiffStart + 4);
        const ifd0Start = tiffStart + ifd0Offset;
        if (buffer.length < ifd0Start + 2) {
          return null;
        }

        const numEntries = readU16(ifd0Start);
        for (let i = 0; i < numEntries; i++) {
          const entryOffset = ifd0Start + 2 + i * 12;
          if (buffer.length < entryOffset + 12) {
            break;
          }

          const tag = readU16(entryOffset);
          // Orientation tag = 0x0112
          if (tag === 0x0112) {
            const value = readU16(entryOffset + 8);
            return value >= 1 && value <= 8 ? value : null;
          }
        }
      }
      return null;
    }

    // Skip other segments
    if (marker >= 0xe0 && marker <= 0xef) {
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
      continue;
    }

    // SOF, SOS, or other marker - stop searching
    if (marker === 0xc0 || marker === 0xda) {
      break;
    }

    offset++;
  }

  return null;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-img-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sipsMetadataFromBuffer(buffer: Buffer): Promise<ImageMetadata | null> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    await fs.writeFile(input, buffer);
    const { stdout } = await runExec(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", input],
      {
        timeoutMs: 10_000,
        maxBuffer: 512 * 1024,
      },
    );
    const w = stdout.match(/pixelWidth:\s*([0-9]+)/);
    const h = stdout.match(/pixelHeight:\s*([0-9]+)/);
    if (!w?.[1] || !h?.[1]) {
      return null;
    }
    const width = Number.parseInt(w[1], 10);
    const height = Number.parseInt(h[1], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  });
}

async function sipsResizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
}): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, params.buffer);
    await runExec(
      "/usr/bin/sips",
      [
        "-Z",
        String(Math.max(1, Math.round(params.maxSide))),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.max(1, Math.min(100, Math.round(params.quality)))),
        input,
        "--out",
        output,
      ],
      { timeoutMs: 20_000, maxBuffer: 1024 * 1024 },
    );
    return await fs.readFile(output);
  });
}

async function sipsConvertToJpeg(buffer: Buffer): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.heic");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, buffer);
    await runExec("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], {
      timeoutMs: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return await fs.readFile(output);
  });
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const metadataForLimit = await readImageMetadataForLimit(buffer).catch(() => null);
  if (metadataForLimit) {
    try {
      return validateImagePixelLimit(metadataForLimit);
    } catch {
      return null;
    }
  }

  if (prefersSips()) {
    return await sipsMetadataFromBuffer(buffer).catch(() => null);
  }

  try {
    const ops = await loadMediaAttachmentImageOps();
    const meta = await ops.getImageMetadata(buffer);
    return meta ? validateImagePixelLimit(meta) : null;
  } catch {
    return null;
  }
}

/**
 * Applies rotation/flip to image buffer using sips based on EXIF orientation.
 */
async function sipsApplyOrientation(buffer: Buffer, orientation: number): Promise<Buffer> {
  // Map EXIF orientation to sips operations
  // sips -r rotates clockwise, -f flips (horizontal/vertical)
  const ops: string[] = [];
  switch (orientation) {
    case 2: // Flip horizontal
      ops.push("-f", "horizontal");
      break;
    case 3: // Rotate 180
      ops.push("-r", "180");
      break;
    case 4: // Flip vertical
      ops.push("-f", "vertical");
      break;
    case 5: // Rotate 270 CW + flip horizontal
      ops.push("-r", "270", "-f", "horizontal");
      break;
    case 6: // Rotate 90 CW
      ops.push("-r", "90");
      break;
    case 7: // Rotate 90 CW + flip horizontal
      ops.push("-r", "90", "-f", "horizontal");
      break;
    case 8: // Rotate 270 CW
      ops.push("-r", "270");
      break;
    default:
      // Orientation 1 or unknown - no change needed
      return buffer;
  }

  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.jpg");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, buffer);
    await runExec("/usr/bin/sips", [...ops, input, "--out", output], {
      timeoutMs: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return await fs.readFile(output);
  });
}

/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  await assertImagePixelLimit(buffer);

  if (prefersSips()) {
    try {
      const orientation = readJpegExifOrientation(buffer);
      if (!orientation || orientation === 1) {
        return buffer; // No rotation needed
      }
      return await sipsApplyOrientation(buffer, orientation);
    } catch {
      return buffer;
    }
  }

  try {
    const ops = await loadMediaAttachmentImageOps();
    return await ops.normalizeExifOrientation(buffer);
  } catch {
    return buffer;
  }
}

export async function resizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  await assertImagePixelLimit(params.buffer);

  if (prefersSips()) {
    // Normalize EXIF orientation BEFORE resizing (sips resize doesn't auto-rotate)
    const normalized = await normalizeExifOrientationSips(params.buffer);

    // Avoid enlarging by checking dimensions first (sips has no withoutEnlargement flag).
    if (params.withoutEnlargement !== false) {
      const meta = await getImageMetadata(normalized);
      if (meta) {
        const maxDim = Math.max(meta.width, meta.height);
        if (maxDim > 0 && maxDim <= params.maxSide) {
          return await sipsResizeToJpeg({
            buffer: normalized,
            maxSide: maxDim,
            quality: params.quality,
          });
        }
      }
    }
    return await sipsResizeToJpeg({
      buffer: normalized,
      maxSide: params.maxSide,
      quality: params.quality,
    });
  }

  const ops = await loadMediaAttachmentImageOps();
  return await ops.resizeToJpeg(params);
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  await assertImagePixelLimit(buffer);

  if (prefersSips()) {
    return await sipsConvertToJpeg(buffer);
  }
  const ops = await loadMediaAttachmentImageOps();
  return await ops.convertHeicToJpeg(buffer);
}

/**
 * Checks if an image has an alpha channel (transparency).
 * Returns true if the image has alpha, false otherwise.
 */
export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  await assertImagePixelLimit(buffer);

  try {
    const ops = await loadMediaAttachmentImageOps();
    return await ops.hasAlphaChannel(buffer);
  } catch {
    return false;
  }
}

/**
 * Resizes an image to PNG format, preserving alpha channel (transparency).
 * Falls back to the media attachments plugin only (no sips fallback for PNG with alpha).
 */
export async function resizeToPng(params: {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  await assertImagePixelLimit(params.buffer);

  const ops = await loadMediaAttachmentImageOps();
  return await ops.resizeToPng(params);
}

export async function optimizeImageToPng(
  buffer: Buffer,
  maxBytes: number,
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}> {
  // Try a grid of sizes/compression levels until under the limit.
  // PNG uses compression levels 0-9 (higher = smaller but slower).
  const sides = [2048, 1536, 1280, 1024, 800];
  const compressionLevels = [6, 7, 8, 9];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    compressionLevel: number;
  } | null = null;

  for (const side of sides) {
    for (const compressionLevel of compressionLevels) {
      try {
        const out = await resizeToPng({
          buffer,
          maxSide: side,
          compressionLevel,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, compressionLevel };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            compressionLevel,
          };
        }
      } catch {
        // Continue trying other size/compression combinations.
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      compressionLevel: smallest.compressionLevel,
    };
  }

  throw new Error("Failed to optimize PNG image");
}

/**
 * Internal sips-only EXIF normalization (no sharp fallback).
 * Used by resizeToJpeg to normalize before sips resize.
 */
async function normalizeExifOrientationSips(buffer: Buffer): Promise<Buffer> {
  try {
    const orientation = readJpegExifOrientation(buffer);
    if (!orientation || orientation === 1) {
      return buffer;
    }
    return await sipsApplyOrientation(buffer, orientation);
  } catch {
    return buffer;
  }
}
