import fs from "node:fs/promises";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import type { ImageMetadata } from "./image-ops.js";

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

type ImageOpsWorkerRequest = {
  operation?: unknown;
  inputPath?: unknown;
  outputPath?: unknown;
  maxInputPixels?: unknown;
  maxSide?: unknown;
  quality?: unknown;
  compressionLevel?: unknown;
  withoutEnlargement?: unknown;
};

const MEDIA_UNDERSTANDING_CORE_PLUGIN_ID = "media-understanding-core";
const MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT = "image-ops.js";
const MAX_STDIN_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Image worker request requires ${label}`);
  }
  return value;
}

function normalizePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Image worker request requires positive ${label}`);
  }
  return value;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeOptionalCompressionLevel(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Image worker request requires non-negative compressionLevel");
  }
  const parsed = value;
  return Math.max(0, Math.min(9, Math.round(parsed)));
}

function loadImageOps(maxInputPixels: number): MediaAttachmentImageOps {
  const mod = loadBundledPluginPublicArtifactModuleSync<MediaAttachmentImageOpsModule>({
    dirName: MEDIA_UNDERSTANDING_CORE_PLUGIN_ID,
    artifactBasename: MEDIA_UNDERSTANDING_CORE_IMAGE_OPS_ARTIFACT,
  });
  const ops = mod.createMediaAttachmentImageOps?.({
    maxInputPixels,
  });
  if (!ops) {
    throw new Error("Media understanding core did not expose image ops");
  }
  return ops;
}

async function readStdinJson(): Promise<ImageOpsWorkerRequest> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_STDIN_BYTES) {
      throw new Error("Image worker request exceeded stdin limit");
    }
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Image worker request must be a JSON object");
  }
  return parsed;
}

async function writeJson(value: unknown): Promise<void> {
  const packet = `${JSON.stringify(value)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(packet, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const request = await readStdinJson();
  const operation = normalizeString(request.operation, "operation");
  const inputPath = normalizeString(request.inputPath, "inputPath");
  const maxInputPixels = normalizePositiveNumber(request.maxInputPixels, "maxInputPixels");
  const inputBuffer = await fs.readFile(inputPath);
  const ops = loadImageOps(maxInputPixels);

  switch (operation) {
    case "getImageMetadata": {
      await writeJson({ ok: true, metadata: await ops.getImageMetadata(inputBuffer) });
      return;
    }
    case "normalizeExifOrientation": {
      const outputPath = normalizeString(request.outputPath, "outputPath");
      await fs.writeFile(outputPath, await ops.normalizeExifOrientation(inputBuffer));
      await writeJson({ ok: true });
      return;
    }
    case "resizeToJpeg": {
      const outputPath = normalizeString(request.outputPath, "outputPath");
      await fs.writeFile(
        outputPath,
        await ops.resizeToJpeg({
          buffer: inputBuffer,
          maxSide: normalizePositiveNumber(request.maxSide, "maxSide"),
          quality: normalizePositiveNumber(request.quality, "quality"),
          withoutEnlargement: normalizeOptionalBoolean(request.withoutEnlargement),
        }),
      );
      await writeJson({ ok: true });
      return;
    }
    case "convertHeicToJpeg": {
      const outputPath = normalizeString(request.outputPath, "outputPath");
      await fs.writeFile(outputPath, await ops.convertHeicToJpeg(inputBuffer));
      await writeJson({ ok: true });
      return;
    }
    case "hasAlphaChannel": {
      await writeJson({ ok: true, value: await ops.hasAlphaChannel(inputBuffer) });
      return;
    }
    case "resizeToPng": {
      const outputPath = normalizeString(request.outputPath, "outputPath");
      await fs.writeFile(
        outputPath,
        await ops.resizeToPng({
          buffer: inputBuffer,
          maxSide: normalizePositiveNumber(request.maxSide, "maxSide"),
          compressionLevel: normalizeOptionalCompressionLevel(request.compressionLevel),
          withoutEnlargement: normalizeOptionalBoolean(request.withoutEnlargement),
        }),
      );
      await writeJson({ ok: true });
      return;
    }
    default:
      throw new Error(`Unsupported image worker operation: ${operation}`);
  }
}

main().catch(async (error) => {
  await writeJson({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => {});
  process.exitCode = 1;
});
