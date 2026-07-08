import type { OpenClawConfig } from "../config/types.js";
// Shared image compression for media-understanding provider execution.
import { optimizeImageBufferForWebMedia } from "../media/web-media.js";
import type { ImageCompressionPolicy } from "../media/web-media.js";

/** Compresses an image buffer per agent defaults config, if configured. */
export async function compressImageForDescription(params: {
  buffer: Buffer;
  mime?: string;
  fileName?: string;
  maxBytes?: number;
  cfg?: OpenClawConfig;
}): Promise<{ buffer: Buffer; mime?: string }> {
  const maxDimensionPx = params.cfg?.agents?.defaults?.imageMaxDimensionPx;
  const imageQuality = params.cfg?.agents?.defaults?.imageQuality;

  const validDimension = typeof maxDimensionPx === "number" && Number.isFinite(maxDimensionPx);

  const compressionPolicy: ImageCompressionPolicy | undefined =
    validDimension || imageQuality
      ? {
          ...(imageQuality ? { quality: imageQuality } : {}),
          ...(validDimension
            ? { models: [{ maxSidePx: Math.max(1, Math.floor(maxDimensionPx)) }] }
            : {}),
        }
      : undefined;

  if (!compressionPolicy) {
    return { buffer: params.buffer, mime: params.mime };
  }

  const result = await optimizeImageBufferForWebMedia({
    buffer: params.buffer,
    contentType: params.mime,
    fileName: params.fileName,
    maxBytes: params.maxBytes,
    imageCompression: compressionPolicy,
  });

  return {
    buffer: result.buffer,
    mime: result.contentType,
  };
}
