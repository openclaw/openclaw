import { readImageMetadataFromHeader } from "../media/image-ops.js";
import { MAX_IMAGE_INPUT_PIXELS } from "../media/image-processor-config.js";
import { createImageProcessor } from "../media/image-processor.js";
import type { TuiImageData } from "./tui-backend.js";

export const TUI_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const TUI_IMAGE_MAX_SIDE = 300;

export function decodeTuiImageData(source: string): Buffer | undefined {
  if (!source.startsWith("data:")) {
    return undefined;
  }
  if (source.length > Math.ceil(TUI_IMAGE_MAX_BYTES / 3) * 4 + 100) {
    throw new Error("Image exceeds the preview byte limit");
  }
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source);
  if (!match?.[1]) {
    throw new Error("Unsupported inline image");
  }
  return Buffer.from(match[1], "base64");
}

export async function prepareTuiImage(buffer: Buffer, signal: AbortSignal): Promise<TuiImageData> {
  signal.throwIfAborted();
  if (buffer.byteLength > TUI_IMAGE_MAX_BYTES) {
    throw new Error("Image exceeds the preview byte limit");
  }
  const dimensions = readImageMetadataFromHeader(buffer);
  if (!dimensions || dimensions.width * dimensions.height > MAX_IMAGE_INPUT_PIXELS) {
    throw new Error("Unsupported image or image exceeds the preview pixel limit");
  }
  const { data } = await createImageProcessor().encode(buffer, {
    format: "png",
    resize: { maxSide: TUI_IMAGE_MAX_SIDE, enlarge: false },
    compressionLevel: 8,
    signal,
  });
  signal.throwIfAborted();
  if (data.byteLength > TUI_IMAGE_MAX_BYTES) {
    throw new Error("Image exceeds the preview byte limit");
  }
  return { data: data.toString("base64"), mimeType: "image/png" };
}
